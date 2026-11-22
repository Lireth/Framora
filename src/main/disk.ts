/**
 * 磁盘可用空间探测：写回编辑、恢复备份等会额外占用与源文件同量级空间的操作用它做前置校验，
 * 避免写到一半遇到 ENOSPC 留下半成品。statfs 不可用时返回 null，调用方按"未知"放行。
 */
import fs from 'node:fs'
import { formatBytes } from '@shared/formats'

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** 低于所需空间时抛出可读错误；无法探测时不做阻断 */
export async function assertFreeSpace(
  dir: string,
  neededBytes: number,
  action: string
): Promise<void> {
  const free = await freeBytes(dir)
  if (free === null) return
  if (free < neededBytes) {
    throw new Error(
      `磁盘空间不足，无法${action}：预计需要 ${formatBytes(neededBytes)}，当前可用 ${formatBytes(free)}`
    )
  }
}

/* ---------- 有界并发批量 IO（OPT-46） ---------- */

/** 目录级 stat/rm 扫描的默认并发度 */
export const IO_CONCURRENCY = 32

/**
 * 有界并发映射：替代对目录全量文件的无界 Promise.all——万级文件的 stat/rm 会
 * 瞬时产生数万并发 promise（句柄与内存毛刺），且 storage:stats 等入口可被 UI
 * 反复触发。结果与输入顺序一致；fn 应自行兜底错误（扫描类调用逐项忽略失败），
 * 异常会传导给调用方。
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
