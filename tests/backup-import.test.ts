/**
 * 备份导入安全回归：
 * - 版本上界 / 核心表 / integrity_check 校验在关闭当前库之前完成；
 * - 同卷临时副本 + rename 原子替换，迁移失败可回滚并重开原库；
 * - 启动时能恢复被中断的导入（临时副本或 .pre-import 原库）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBoxSync: () => 0 },
}))

import * as db from '../src/main/db'

const IMPORT_TS = Date.parse('2026-01-01T00:00:00Z')

function seed(folderId: number, name: string): number {
  return db.insertPhoto({
    folder_id: folderId,
    path: `C:\\pics\\${name}.jpg`,
    name: `${name}.jpg`,
    ext: 'jpg',
    size: 1000,
    mtime: 1,
    imported_at: IMPORT_TS,
  })
}

async function exportBackup(name: string): Promise<string> {
  const p = path.join(userData, name)
  await db.exportBackup(p)
  return p
}

function dbFile(): string {
  return path.join(userData, 'framora.db')
}

beforeEach(async () => {
  userData = mkdtempSync(path.join(tmpdir(), 'framora-import-test-'))
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

describe('备份导入校验', () => {
  it('校验通过后原子替换并重开，旧库保留为 .pre-import', async () => {
    const f = db.addFolder('C:\\pics', 'pics')
    seed(f, 'in-backup')
    db.setSetting('marker', 'backup')
    const backup = await exportBackup('good.db')

    seed(f, 'current-only')
    db.setSetting('marker', 'current')
    expect(db.libraryStats().total).toBe(2)

    await db.importBackup(backup)
    expect(db.getSetting('marker')).toBe('backup')
    expect(db.libraryStats().total).toBe(1)
    expect(readdirSync(userData).some((n) => n.startsWith('framora.db.pre-import-'))).toBe(true)
    expect(readdirSync(userData).some((n) => n.startsWith('framora.db.importing-'))).toBe(false)
  })

  it('拒绝更高 schema 版本的备份，当前库保持可用', async () => {
    db.setSetting('marker', 'alive')
    const backup = await exportBackup('future.db')
    const raw = new Database(backup)
    raw.pragma('user_version = 999')
    raw.close()

    await expect(db.importBackup(backup)).rejects.toThrow(/更新版本|999/)
    expect(db.getSetting('marker')).toBe('alive')
    expect(db.libraryStats().total).toBe(0)
  })

  it('拒绝非 SQLite 文件与缺核心表的文件', async () => {
    db.setSetting('marker', 'alive')
    const bad = path.join(userData, 'bad.db')
    writeFileSync(bad, 'this is not sqlite')
    await expect(db.importBackup(bad)).rejects.toThrow(/无法(打开|读取)备份文件/)

    const partial = path.join(userData, 'partial.db')
    const raw = new Database(partial)
    raw.exec('CREATE TABLE photos(id INTEGER PRIMARY KEY); PRAGMA user_version = 11;')
    raw.close()
    await expect(db.importBackup(partial)).rejects.toThrow(/缺少必要数据表/)
    expect(db.getSetting('marker')).toBe('alive')
  })

  it('拒绝含未合并 WAL 的备份与当前正在使用的索引库', async () => {
    const backup = await exportBackup('wal.db')
    writeFileSync(`${backup}-wal`, Buffer.from([1, 2, 3]))
    await expect(db.importBackup(backup)).rejects.toThrow(/WAL/)
    await expect(db.importBackup(dbFile())).rejects.toThrow(/正在使用/)
    expect(db.libraryStats().total).toBe(0)
  })

  it('迁移失败时回滚并重开原库，不留下半成品', async () => {
    const f = db.addFolder('C:\\pics', 'pics')
    seed(f, 'keep-me')
    db.setSetting('marker', 'alive')

    // 核心表存在但 schema 极简：v1 建索引时即失败，用于验证 swap 后的回滚路径
    const fake = path.join(userData, 'fake.db')
    const raw = new Database(fake)
    raw.exec(`
      CREATE TABLE folders(id INTEGER PRIMARY KEY, path TEXT, name TEXT, added_at INTEGER);
      CREATE TABLE photos(id INTEGER PRIMARY KEY);
      CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT, color TEXT);
      CREATE TABLE photo_tags(photo_id INTEGER, tag_id INTEGER);
      CREATE TABLE albums(id INTEGER PRIMARY KEY, name TEXT, color TEXT, created_at INTEGER);
      CREATE TABLE album_photos(album_id INTEGER, photo_id INTEGER);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 0;
    `)
    raw.close()

    await expect(db.importBackup(fake)).rejects.toThrow(/已恢复原索引库|回滚/)
    expect(db.getSetting('marker')).toBe('alive')
    expect(db.libraryStats().total).toBe(1)
    expect(readdirSync(userData).some((n) => n.startsWith('framora.db.importing-'))).toBe(false)
  })
})

describe('启动时恢复被中断的导入', () => {
  it('目标库缺失时优先提升完整临时副本', async () => {
    db.setSetting('marker', 'recover-temp')
    db.closeDb()
    const temp = `${dbFile()}.importing-1234567890123`
    renameSync(dbFile(), temp)
    expect(existsSync(dbFile())).toBe(false)

    await db.initDb()
    expect(db.getSetting('marker')).toBe('recover-temp')
    expect(existsSync(temp)).toBe(false)
  })

  it('提升临时副本前清除旧 WAL/SHM，避免错套到新库', async () => {
    db.setSetting('marker', 'recover-sidecar')
    db.closeDb()
    const temp = `${dbFile()}.importing-1234567890124`
    renameSync(dbFile(), temp)
    writeFileSync(`${dbFile()}-wal`, Buffer.from('stale-wal'))
    writeFileSync(`${dbFile()}-shm`, Buffer.from('stale-shm'))

    await db.initDb()
    expect(db.getSetting('marker')).toBe('recover-sidecar')
  })

  it('无临时副本时回退到最近一次 .pre-import 原库', async () => {
    db.setSetting('marker', 'recover-pre')
    db.closeDb()
    const pre = `${dbFile()}.pre-import-1234567890123`
    renameSync(dbFile(), pre)

    await db.initDb()
    expect(db.getSetting('marker')).toBe('recover-pre')
    expect(existsSync(pre)).toBe(false)
  })

  it('目标库正常时清理残留临时文件', async () => {
    const temp = `${dbFile()}.importing-999`
    writeFileSync(temp, 'stale')
    db.closeDb()

    await db.initDb()
    expect(existsSync(temp)).toBe(false)
    expect(db.libraryStats().total).toBe(0)
  })
})
