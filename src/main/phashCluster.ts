/**
 * 相似聚类计算调度：将 O(n·k) 贪心聚类放入 worker_threads 执行，
 * 避免首次进入「疑似重复」视图或哈希/缺失状态变化后在主进程长任务阻塞 IPC。
 *
 * phashCore 为零依赖纯函数，worker 脚本由构建产物 out/main/phashWorker.js 提供；
 * worker 不可用（脚本缺失/加载失败）时自动回退主进程同步计算，保证功能可用。
 */
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { clusterPhashes, type PhashRow } from './phashCore'
import { logError } from './log'

export type { PhashRow }

interface ClusterRequest {
  id: number
  rows: PhashRow[]
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
/** worker 启动失败后置位：后续查询直接走主进程回退，避免每次重复失败 */
let workerBroken = false
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

/** 相似聚类：worker 内计算；worker 不可用时自动回退主进程同步计算 */
export async function computePhashClusters(rows: PhashRow[], threshold = 6): Promise<number[][]> {
  if (!rows.length) return []
  if (!workerBroken) {
    try {
      const w = ensureWorker()
      const id = ++seq
      return await new Promise<number[][]>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        w.postMessage({ id, rows, threshold } satisfies ClusterRequest)
      })
    } catch (err) {
      if (!(err instanceof WorkerUnavailableError)) throw err
      workerBroken = true
      logError('phashCluster', err)
    }
  }
  return clusterPhashes(rows, threshold)
}
