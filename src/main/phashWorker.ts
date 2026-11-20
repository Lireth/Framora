/**
 * 相似聚类 worker：接收 phash 行，执行贪心聚类后回传结果。
 * 独立构建入口（electron-vite main.rollupOptions.input → out/main/phashWorker.js），
 * 由主进程 phashCluster.ts 经 worker_threads 加载，将 O(n·k) 聚类移出主进程。
 */
import { parentPort } from 'node:worker_threads'
import { clusterPhashes, type PhashRow } from './phashCore'

interface ClusterRequest {
  id: number
  rows: PhashRow[]
  threshold?: number
}

parentPort?.on('message', (msg: ClusterRequest) => {
  try {
    const clusters = clusterPhashes(msg.rows, msg.threshold)
    parentPort!.postMessage({ id: msg.id, clusters })
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
  }
})
