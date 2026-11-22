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
import { IO_CONCURRENCY, freeBytes as probeFreeBytes, mapLimited } from './disk'
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

async function scanDir(dir: string, match: (name: string) => boolean): Promise<StorageBucket> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return { bytes: 0, files: 0 }
  }
  let bytes = 0
  let files = 0
  // 有界并发 stat（OPT-46）：thumbs 目录 2 万+ 文件时无界 Promise.all 会瞬时产生
  // 数万并发 promise，且 storage:stats 可被 UI 反复触发
  await mapLimited(
    names.filter(match),
    IO_CONCURRENCY,
    async (name) => {
      try {
        const st = await fs.promises.stat(path.join(dir, name))
        if (st.isFile()) {
          bytes += st.size
          files++
        }
      } catch {
        /* 单文件不可读忽略 */
      }
    }
  )
  return { bytes, files }
}

/** 索引库主文件 + WAL/SHM */
async function dbStats(): Promise<StorageBucket> {
  const base = path.join(userDataDir(), 'framora.db')
  let bytes = 0
  let files = 0
  await Promise.all(
    ['', '-wal', '-shm'].map(async (suffix) => {
      try {
        const st = await fs.promises.stat(base + suffix)
        if (st.isFile()) {
          bytes += st.size
          files++
        }
      } catch {
        /* 文件不存在 */
      }
    }),
  )
  return { bytes, files }
}

/** 迁移前滚动备份 + 备份导入 .pre-import + 损坏隔离文件 */
async function dbBackupStats(): Promise<StorageBucket> {
  const rolling = await scanDir(path.join(userDataDir(), 'db-backups'), (n) =>
    n.startsWith('framora-')
  )
  const preImport = await scanDir(userDataDir(), (n) => n.startsWith('framora.db.pre-import-'))
  const quarantined = await scanDir(userDataDir(), (n) => n.startsWith('framora.db.corrupt-'))
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
  const [dbBucket, thumbs, previews, backups, logs, dbBackups] = await Promise.all([
    dbStats(),
    scanDir(thumbsDir(), (n) => n.endsWith('.webp')),
    previewStats(),
    backupStats(),
    scanDir(logsDir(), (n) => n.endsWith('.log')),
    dbBackupStats(),
  ])
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
export async function enforceStorageBudgets(): Promise<StorageEnforceResult> {
  return {
    previews: await enforcePreviewBudget(),
    backups: await enforceBackupBudget(),
  }
}

/** 清空全部 RAW 预览缓存（按需重建） */
export async function cleanAllPreviews(): Promise<CleanupResult> {
  return clearPreviews()
}
