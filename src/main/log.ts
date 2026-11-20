import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

let logFile: string | null = null

/** 日志保留天数，超期文件启动时清理 */
const LOG_RETENTION_DAYS = 30

export function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

export function initLogging(): void {
  try {
    const dir = logsDir()
    fs.mkdirSync(dir, { recursive: true })
    cleanupOldLogs(dir)
    logFile = path.join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`)
    append(`[session] app starting, userData=${app.getPath('userData')}`)
  } catch {
    logFile = null
  }
}

function cleanupOldLogs(dir: string): void {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith('main-') || !name.endsWith('.log')) continue
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(p, { force: true })
    } catch {
      /* 单个文件清理失败忽略 */
    }
  }
}

export function logError(tag: string, err: unknown): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  append(`[${new Date().toISOString()}] ${tag}: ${msg}`)
}

function append(line: string): void {
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, line + '\n')
  } catch {
    /* 日志写入失败保持静默，不影响主流程 */
  }
}
