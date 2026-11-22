/**
 * 存储预算与清理策略回归：
 * - RAW 预览按 mtime 最旧优先淘汰，保留最新；
 * - 编辑备份每组至少保留最新一份，预算只裁剪更早历史；
 * - 占用统计覆盖各目录，预算设置有边界收敛。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBoxSync: () => 0 },
}))

import * as db from '../src/main/db'
import * as storage from '../src/main/storage'
import { backupsDir, previewStats, thumbsDir, writePreviewFile } from '../src/main/thumbs'
import { backupStats, cleanupOrphanBackups } from '../src/main/imageops'

const KB = 1024

function writeSized(p: string, size: number, mtimeSec: number): void {
  writeFileSync(p, Buffer.alloc(size, 1))
  const t = new Date(mtimeSec * 1000)
  utimesSync(p, t, t)
}

function previewFile(name: string, size: number, mtimeSec: number): string {
  const p = path.join(thumbsDir(), name)
  writeSized(p, size, mtimeSec)
  return p
}

function backupFile(name: string, size: number, mtimeSec: number): string {
  const p = path.join(backupsDir(), name)
  writeSized(p, size, mtimeSec)
  return p
}

beforeEach(async () => {
  userData = mkdtempSync(path.join(tmpdir(), 'framora-storage-test-'))
  await db.initDb()
})

afterEach(() => {
  db.closeDb()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* Windows 句柄延迟释放，留给临时目录自清理 */
  }
})

describe('RAW 预览预算', () => {
  it('预览写入可覆盖既有文件且不残留临时文件（Windows rename 语义回归）', async () => {
    const p = path.join(thumbsDir(), '5.preview.jpg')
    await writePreviewFile(p, Buffer.from('first'))
    await writePreviewFile(p, Buffer.from('second'))
    expect(readFileSync(p, 'utf8')).toBe('second')
    expect(readdirSync(thumbsDir()).some((n) => n.endsWith('.tmp'))).toBe(false)
  })

  it('按 mtime 淘汰最旧预览，保留最新一份并报告释放量', () => {
    const oldest = previewFile('1.preview.jpg', 600 * KB, 1000)
    const middle = previewFile('2.preview.jpg', 600 * KB, 2000)
    const newest = previewFile('3.preview.jpg', 600 * KB, 3000)
    expect(previewStats()).toEqual({ files: 3, bytes: 1800 * KB })

    db.setSetting('previewBudgetMb', '1')
    const r = storage.enforceStorageBudgets().previews
    expect(r.deleted).toBe(2)
    expect(r.bytes).toBe(1200 * KB)
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(false)
    expect(existsSync(newest)).toBe(true)
    expect(previewStats()).toEqual({ files: 1, bytes: 600 * KB })
  })

  it('预算为 0 时不清理；清空预览不影响缩略图', () => {
    const preview = previewFile('1.preview.jpg', 600 * KB, 1000)
    const thumb = path.join(thumbsDir(), '1.webp')
    writeSized(thumb, 40 * KB, 1000)
    db.setSetting('previewBudgetMb', '0')

    expect(storage.enforceStorageBudgets().previews.deleted).toBe(0)
    expect(existsSync(preview)).toBe(true)

    const cleared = storage.cleanAllPreviews()
    expect(cleared.deleted).toBe(1)
    expect(existsSync(preview)).toBe(false)
    expect(existsSync(thumb)).toBe(true)
  })

  it('单张预览本身超过预算时仍保留最新一份，避免反复重建', () => {
    const only = previewFile('9.preview.jpg', 2 * 1024 * KB, 1000)
    db.setSetting('previewBudgetMb', '1')
    expect(storage.enforceStorageBudgets().previews.deleted).toBe(0)
    expect(existsSync(only)).toBe(true)
  })
})

describe('编辑备份预算', () => {
  it('每组保留最新一份，预算只裁剪更早的历史版本', () => {
    const p1old = backupFile('1-aaaaaaaa-1000.jpg', 600 * KB, 1000)
    const p1mid = backupFile('1-aaaaaaaa-2000.jpg', 600 * KB, 2000)
    const p1new = backupFile('1-aaaaaaaa-3000.jpg', 600 * KB, 3000)
    const p2old = backupFile('2-bbbbbbbb-1000.jpg', 600 * KB, 1000)
    const p2new = backupFile('2-bbbbbbbb-2000.jpg', 600 * KB, 2000)
    expect(backupStats()).toEqual({ files: 5, bytes: 3000 * KB })

    db.setSetting('backupBudgetMb', '1')
    const r = storage.enforceStorageBudgets().backups
    // 最新两份合计 1.2MB 已超 1MB，但必须保留；候选 3 份全部删除
    expect(r.deleted).toBe(3)
    expect(r.bytes).toBe(1800 * KB)
    expect(existsSync(p1old)).toBe(false)
    expect(existsSync(p1mid)).toBe(false)
    expect(existsSync(p2old)).toBe(false)
    expect(existsSync(p1new)).toBe(true)
    expect(existsSync(p2new)).toBe(true)
    expect(backupStats()).toEqual({ files: 2, bytes: 1200 * KB })
  })

  it('预算内不动任何备份', () => {
    const a = backupFile('1-aaaaaaaa-1000.jpg', 100 * KB, 1000)
    db.setSetting('backupBudgetMb', '1')
    expect(storage.enforceStorageBudgets().backups).toEqual({ deleted: 0, bytes: 0 })
    expect(existsSync(a)).toBe(true)
  })

  it('无主备份（照片行不存在的 id 组）可被清理，有主备份保留', () => {
    // id 999 不存在于索引库（删除照片/换库遗留）；id 1 通过插入行保留
    const orphan1 = backupFile('999-cccccccc-1000.jpg', 100 * KB, 1000)
    const orphan2 = backupFile('999-1000.jpg', 100 * KB, 1000)
    const kept = backupFile('1-dddddddd-1000.jpg', 100 * KB, 1000)
    db.insertPhoto({
      folder_id: 0,
      path: 'C:\\pics\\kept.jpg',
      name: 'kept.jpg',
      ext: 'jpg',
      size: 1000,
      mtime: 1,
      imported_at: Date.now(),
    })
    const removed = cleanupOrphanBackups()
    expect(removed).toBe(2)
    expect(existsSync(orphan1)).toBe(false)
    expect(existsSync(orphan2)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })
})

describe('占用统计与预算设置', () => {
  it('未设置预算时返回默认值而非 0（Number(null) 陷阱回归）', () => {
    expect(storage.getStorageLimits()).toEqual({
      previewBudgetMb: 1024,
      backupBudgetMb: 4096,
    })
  })

  it('统计各目录占用并汇总', async () => {
    previewFile('1.preview.jpg', 200 * KB, 1000)
    writeSized(path.join(thumbsDir(), '1.webp'), 40 * KB, 1000)
    backupFile('1-aaaaaaaa-1000.jpg', 300 * KB, 1000)
    const logs = path.join(userData, 'logs')
    mkdirSync(logs, { recursive: true })
    writeSized(path.join(logs, 'main-2026-01-01.log'), 10 * KB, 1000)
    const dbBackups = path.join(userData, 'db-backups')
    mkdirSync(dbBackups, { recursive: true })
    writeSized(path.join(dbBackups, 'framora-v11-1.db'), 500 * KB, 1000)
    writeSized(path.join(userData, 'framora.db.pre-import-1'), 400 * KB, 1000)

    const s = await storage.storageStats()
    expect(s.previews).toEqual({ files: 1, bytes: 200 * KB })
    expect(s.thumbs).toEqual({ files: 1, bytes: 40 * KB })
    expect(s.backups).toEqual({ files: 1, bytes: 300 * KB })
    expect(s.logs).toEqual({ files: 1, bytes: 10 * KB })
    // initDb 首次迁移会额外生成一份 framora-v0-*.db 备份，因此只断言下界
    expect(s.dbBackups.files).toBeGreaterThanOrEqual(2)
    expect(s.dbBackups.bytes).toBeGreaterThanOrEqual(900 * KB)
    expect(s.db.files).toBeGreaterThan(0)
    expect(s.totalBytes).toBe(
      s.db.bytes + s.thumbs.bytes + s.previews.bytes + s.backups.bytes + s.logs.bytes + s.dbBackups.bytes
    )
  })

  it('预算设置写入并收敛非法值', () => {
    const saved = storage.setStorageLimits({ previewBudgetMb: -5, backupBudgetMb: 2048 })
    expect(saved.previewBudgetMb).toBe(1024)
    expect(saved.backupBudgetMb).toBe(2048)
    expect(storage.getStorageLimits()).toEqual(saved)
  })
})
