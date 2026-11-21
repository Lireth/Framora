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
