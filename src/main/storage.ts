/**
 * 存储治理：统计索引库 / 缩略图 / RAW 预览 / 编辑备份 / 日志 / 索引备份的占用，
 * 并提供预算设置与按预算清理入口。
 *
 * 设计原则：
 * - 只清理可再生的派生数据（缩略图、RAW 预览、备份历史），绝不触碰照片文件；
 * - RAW 预览被清理后由 thumb:// 协议按需重建，查看与导出不受影响；
 * - 编辑备份每组（照片 + 路径哈希）至少保留最新一份，预算只裁剪更早的历史版本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import * as db from './db'
import {
  DEFAULT_BACKUP_BUDGET_MB,
  backupStats,
  enforceBackupBudget,
} from './imageops'
import {
  DEFAULT_PREVIEW_BUDGET_MB,
  clearPreviews,
  enforcePreviewBudget,
  previewStats,
  thumbsDir,
} from './thumbs'
import { logsDir } from './log'
import { freeBytes as probeFreeBytes } from './disk'
import type {
  CleanupResult,
  StorageBucket,
  StorageEnforceResult,
  StorageLimits,
  StorageStats,
} from '@shared/types'

const MAX_BUDGET_MB = 1024 * 1024

function userDataDir(): string {
  return app.getPath('userData')
}

function scanDir(dir: string, match: (name: string) => boolean): StorageBucket {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { bytes: 0, files: 0 }
  }
  let bytes = 0
  let files = 0
  for (const name of names) {
    if (!match(name)) continue
    try {
      const st = fs.statSync(path.join(dir, name))
      if (st.isFile()) {
        bytes += st.size
        files++
      }
    } catch {
      /* 单文件不可读忽略 */
    }
  }
  return { bytes, files }
}

/** 索引库主文件 + WAL/SHM */
function dbStats(): StorageBucket {
  const base = path.join(userDataDir(), 'framora.db')
  let bytes = 0
  let files = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const st = fs.statSync(base + suffix)
      if (st.isFile()) {
        bytes += st.size
        files++
      }
    } catch {
      /* 文件不存在 */
    }
  }
  return { bytes, files }
}

/** 迁移前滚动备份 + 备份导入 .pre-import + 损坏隔离文件 */
function dbBackupStats(): StorageBucket {
  const rolling = scanDir(path.join(userDataDir(), 'db-backups'), (n) =>
    n.startsWith('framora-')
  )
  const preImport = scanDir(userDataDir(), (n) => n.startsWith('framora.db.pre-import-'))
  const quarantined = scanDir(userDataDir(), (n) => n.startsWith('framora.db.corrupt-'))
  return {
    bytes: rolling.bytes + preImport.bytes + quarantined.bytes,
    files: rolling.files + preImport.files + quarantined.files,
  }
}

function readBudget(key: string, fallback: number): number {
  try {
    const raw = db.getSetting(key)
    if (raw === null || raw === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
  } catch {
    return fallback
  }
}

function normalizeBudget(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v < 0) return fallback
  return Math.min(MAX_BUDGET_MB, Math.floor(v))
}

export function getStorageLimits(): StorageLimits {
  return {
    previewBudgetMb: readBudget('previewBudgetMb', DEFAULT_PREVIEW_BUDGET_MB),
    backupBudgetMb: readBudget('backupBudgetMb', DEFAULT_BACKUP_BUDGET_MB),
  }
}

/** 保存预算并立即按新预算清理一次 */
export function setStorageLimits(input: StorageLimits): StorageLimits {
  const limits: StorageLimits = {
    previewBudgetMb: normalizeBudget(input.previewBudgetMb, DEFAULT_PREVIEW_BUDGET_MB),
    backupBudgetMb: normalizeBudget(input.backupBudgetMb, DEFAULT_BACKUP_BUDGET_MB),
  }
  db.setSetting('previewBudgetMb', String(limits.previewBudgetMb))
  db.setSetting('backupBudgetMb', String(limits.backupBudgetMb))
  enforceStorageBudgets()
  return limits
}

export async function storageStats(): Promise<StorageStats> {
  const dbBucket = dbStats()
  const thumbs = scanDir(thumbsDir(), (n) => n.endsWith('.webp'))
  const previews = previewStats()
  const backups = backupStats()
  const logs = scanDir(logsDir(), (n) => n.endsWith('.log'))
  const dbBackups = dbBackupStats()
  const totalBytes =
    dbBucket.bytes + thumbs.bytes + previews.bytes + backups.bytes + logs.bytes + dbBackups.bytes
  return {
    db: dbBucket,
    thumbs,
    previews,
    backups,
    logs,
    dbBackups,
    totalBytes,
    freeBytes: await probeFreeBytes(userDataDir()),
    limits: getStorageLimits(),
  }
}

/** 按当前预算清理 RAW 预览与编辑备份历史 */
export function enforceStorageBudgets(): StorageEnforceResult {
  return {
    previews: enforcePreviewBudget(),
    backups: enforceBackupBudget(),
  }
}

/** 清空全部 RAW 预览缓存（按需重建） */
export function cleanAllPreviews(): CleanupResult {
  return clearPreviews()
}
