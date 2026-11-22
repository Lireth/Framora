/**
 * 相似聚类 worker：接收 phash 行，执行分块索引贪心聚类后回传结果。
 * 独立构建入口（electron-vite main.rollupOptions.input → out/main/phashWorker.js），
 * 由主进程 phashCluster.ts 经 worker_threads 加载，将聚类计算移出主进程。
 */
import { parentPort } from 'node:worker_threads'
import { clusterEnhanced, type PhashRowX } from './phashCore'

interface ClusterRequest {
  id: number
  /** 主进程打包的行数据（Transferable 移交，所有权归本 worker） */
  ids: Uint32Array
  lo: Uint32Array
  hi: Uint32Array
  flo: Uint32Array
  fhi: Uint32Array
  cm: Uint32Array
  threshold?: number
}

parentPort?.on('message', (msg: ClusterRequest) => {
  try {
    const rows: PhashRowX[] = new Array(msg.ids.length)
    for (let i = 0; i < msg.ids.length; i++) {
      rows[i] = { id: msg.ids[i], lo: msg.lo[i], hi: msg.hi[i], flo: msg.flo[i], fhi: msg.fhi[i], cm: msg.cm[i] }
    }
    const clusters = clusterEnhanced(rows, msg.threshold ?? 6)
    parentPort!.postMessage({ id: msg.id, clusters })
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
  }
})
