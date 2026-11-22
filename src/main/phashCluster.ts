/**
 * 相似聚类计算调度：将分块索引贪心聚类放入 worker_threads 执行，
 * 避免首次进入「疑似重复」视图或哈希/缺失状态变化后在主进程长任务阻塞 IPC。
 *
 * 聚类本身走 4×16 位分块索引（候选集为真实近邻超集，语义与线性扫描一致），
 * 十万张库的比较次数从十亿级降到百万级；仍放在 worker 中以隔离最坏情况。
 *
 * phashCore 为零依赖纯函数，worker 脚本由构建产物 out/main/phashWorker.js 提供；
 * worker 不可用（脚本缺失/加载失败）时自动回退主进程同步计算，保证功能可用。
 */
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { clusterEnhanced, type PhashRow, type PhashRowX } from './phashCore'
import { logError } from './log'

export type { PhashRow }

interface ClusterRequest {
  id: number
  /** 打包后的行数据（与 ids 等长）：Transferable 零拷贝传递，避免万级行对象结构化克隆 */
  ids: Uint32Array
  lo: Uint32Array
  hi: Uint32Array
  flo: Uint32Array
  fhi: Uint32Array
  cm: Uint32Array
  threshold?: number
}

interface ClusterResponse {
  id: number
  clusters?: number[][]
  error?: string
}

/** worker 启动/通信层失败（区别于聚类本身的计算错误） */
class WorkerUnavailableError extends Error {}

let worker: Worker | null = null
/** worker 启动失败的时间戳：短窗内直接主进程回退，超过窗口后允许重试重建（OPT-34）——
 *  此前一次失败永久降级，恰恰失去了 worker 存在的意义（隔离主进程秒级长任务） */
let workerBrokenAt = 0
const WORKER_RETRY_MS = 5 * 60 * 1000
let seq = 0
const pending = new Map<number, { resolve: (c: number[][]) => void; reject: (e: Error) => void }>()

/** 测试可覆盖 worker 脚本路径；生产为构建产物 out/main/phashWorker.js */
function workerFile(): string {
  return process.env['FRAMORA_PHASH_WORKER'] ?? path.join(__dirname, 'phashWorker.js')
}

function resetWorker(reason: Error): void {
  const w = worker
  worker = null
  const ps = [...pending.values()]
  pending.clear()
  for (const p of ps) p.reject(reason)
  if (w) void w.terminate().catch(() => undefined)
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(workerFile())
  w.on('message', (msg: ClusterResponse) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    workerBrokenAt = 0
    if (msg.error !== undefined) p.reject(new Error(`聚类 worker 计算失败: ${msg.error}`))
    else p.resolve(msg.clusters ?? [])
  })
  w.on('error', (err) => {
    resetWorker(new WorkerUnavailableError(`聚类 worker 不可用: ${err.message}`))
  })
  w.on('exit', (code) => {
    if (worker === w) resetWorker(new WorkerUnavailableError(`聚类 worker 意外退出(code=${code})`))
  })
  worker = w
  return w
}

/** 测试隔离：终止当前 worker 并清空降级时间戳（仅测试使用） */
export function __resetPhashWorkerForTest(): void {
  resetWorker(new WorkerUnavailableError('test reset'))
  workerBrokenAt = 0
}

/** 相似聚类：worker 内计算；worker 不可用时自动回退主进程同步计算（时间窗后重试） */
export async function computePhashClusters(rows: PhashRow[], threshold = 6): Promise<number[][]> {
  if (!rows.length) return []
  if (!workerBrokenAt || Date.now() - workerBrokenAt >= WORKER_RETRY_MS) {
    try {
      const w = ensureWorker()
      const id = ++seq
      // 行对象数组经结构化克隆传递在十万级库上是数十 MB 级拷贝：打包为 6 个
      // Uint32Array 以 Transferable 零拷贝移交，worker 内还原（OPT-34）
      const n = rows.length
      const ids = new Uint32Array(n)
      const lo = new Uint32Array(n)
      const hi = new Uint32Array(n)
      const flo = new Uint32Array(n)
      const fhi = new Uint32Array(n)
      const cm = new Uint32Array(n)
      for (let i = 0; i < n; i++) {
        const r = rows[i] as PhashRow & Partial<PhashRowX>
        ids[i] = r.id >>> 0
        lo[i] = r.lo >>> 0
        hi[i] = r.hi >>> 0
        flo[i] = (r.flo ?? r.lo) >>> 0
        fhi[i] = (r.fhi ?? r.hi) >>> 0
        cm[i] = (r.cm ?? 0) >>> 0
      }
      return await new Promise<number[][]>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        w.postMessage({ id, ids, lo, hi, flo, fhi, cm, threshold } satisfies ClusterRequest, [
          ids.buffer,
          lo.buffer,
          hi.buffer,
          flo.buffer,
          fhi.buffer,
          cm.buffer,
        ])
      })
    } catch (err) {
      if (!(err instanceof WorkerUnavailableError)) throw err
      workerBrokenAt = Date.now()
      logError('phashCluster', err)
    }
  }
  // 回退路径同样走增强聚类（颜色拆簇 + 镜像）保持语义一致
  return clusterEnhanced(
    rows.map((r) => ({
      id: r.id,
      lo: r.lo,
      hi: r.hi,
      flo: (r as PhashRowX).flo ?? r.lo,
      fhi: (r as PhashRowX).fhi ?? r.hi,
      cm: (r as PhashRowX).cm ?? 0,
    })),
    threshold,
  )
}
