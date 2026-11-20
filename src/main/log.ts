import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

let logFile: string | null = null

export function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

export function initLogging(): void {
  try {
    const dir = logsDir()
    fs.mkdirSync(dir, { recursive: true })
    logFile = path.join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`)
    append(`[session] app starting, userData=${app.getPath('userData')}`)
  } catch {
    logFile = null
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
