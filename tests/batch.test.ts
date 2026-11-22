/**
 * P1-3 批量写路径与搜索文本脏队列回归：
 * 集合写入语义、已删元数据过滤、后台自动冲刷、导出/关闭前的一致性保证，
 * 以及万级批量的耗时基线（避免退回逐 id 写入）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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

vi.mock('../src/main/phash', () => ({ enqueuePhash: vi.fn(), bumpPhashGeneration: vi.fn() }))

let folderId: number

function bulkPhotos(n: number, prefix = 'bulk'): number[] {
  const rows = Array.from({ length: n }, (_, i) => ({
    folder_id: folderId,
    path: `C:\\bulk\\${prefix}-${i}.jpg`,
    name: `${prefix}-${i}.jpg`,
    ext: 'jpg',
    size: 1000 + i,
    mtime: 1,
    imported_at: 1,
  }))
  return db.insertPhotosBatch(rows)
}

beforeEach(async () => {
  userData = mkdtempSync(path.join(tmpdir(), 'framora-batch-test-'))
  await db.initDb()
  folderId = db.addFolder('C:\\bulk', 'bulk')
})

afterEach(() => {
  db.closeDb()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* Windows 句柄延迟释放：留给临时目录自清理 */
  }
})

function tagNames(id: number): string[] {
  return (db.getPhotoRecord(id)?.tags ?? []).map((t) => t.name)
}

describe('批量标签（集合写入）', () => {
  it('只写入未删除标签，关系与检索文本一致', () => {
    const ids = bulkPhotos(3)
    const keep = db.createTag('保留标签', null)
    const hidden = db.createTag('隐藏标签', null)
    db.deleteTag(hidden.id)

    db.batchTags(ids, [keep.id, hidden.id], [])
    expect(ids.map(tagNames)).toEqual([['保留标签'], ['保留标签'], ['保留标签']])
    expect(db.queryPhotos({ scope: 'all', keyword: '保留标签' }).total).toBe(3)
    expect(db.queryPhotos({ scope: 'all', keyword: '隐藏标签' }).total).toBe(0)

    db.batchTags(ids, [], [keep.id])
    expect(ids.map(tagNames)).toEqual([[], [], []])
    expect(db.queryPhotos({ scope: 'all', keyword: '保留标签' }).total).toBe(0)
  })

  it('重复 id 不产生重复关系，空 id 列表为空操作', () => {
    const [a] = bulkPhotos(1, 'dup')
    const tag = db.createTag('去重标签', null)
    db.batchTags([a, a, a], [tag.id], [])
    expect(tagNames(a)).toEqual(['去重标签'])
    db.batchTags([], [tag.id], [])
    expect(tagNames(a)).toEqual(['去重标签'])
  })
})

describe('批量星级 / 相册 / 回收站（集合写入）', () => {
  it('批量星级覆盖整批，单张可再调整', () => {
    const ids = bulkPhotos(1200)
    db.batchRate(ids, 5)
    expect(db.queryPhotos({ scope: 'all', minRating: 5 }).total).toBe(1200)
    db.batchRate([ids[0]], 0)
    expect(db.queryPhotos({ scope: 'all', minRating: 5 }).total).toBe(1199)
  })

  it('批量入册/移出相册立即反映在作用域、计数与检索', () => {
    const ids = bulkPhotos(800)
    const album = db.createAlbum('批量相册', null)
    db.batchAlbum(ids, album)
    expect(db.queryPhotos({ scope: 'album', scopeId: album }).total).toBe(800)
    expect(db.listAlbums()[0].count).toBe(800)
    expect(db.queryPhotos({ scope: 'all', keyword: '批量相册' }).total).toBe(800)

    db.batchAlbum(ids, null)
    expect(db.queryPhotos({ scope: 'album', scopeId: album }).total).toBe(0)
    expect(db.queryPhotos({ scope: 'all', keyword: '批量相册' }).total).toBe(0)

    // 已删除相册不接收新成员
    db.deleteAlbum(album)
    db.batchAlbum(ids, album)
    expect(db.queryPhotos({ scope: 'album', scopeId: album }).total).toBe(0)
  })

  it('回收站批量进入/还原幂等，计数只统计实际变更', () => {
    const ids = bulkPhotos(500)
    expect(db.softDeletePhotos(ids)).toBe(500)
    expect(db.softDeletePhotos(ids)).toBe(0)
    expect(db.libraryStats().trash).toBe(500)
    expect(db.restorePhotos(ids)).toBe(500)
    expect(db.restorePhotos(ids)).toBe(0)
    expect(db.libraryStats().trash).toBe(0)
  })
})

describe('搜索文本脏队列', () => {
  it('v13 移除照片插入同步搜索触发器（全量脏队列化），相册触发器亦不存在', () => {
    const raw = new Database(path.join(userData, 'framora.db'), { readonly: true })
    try {
      const names = (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
          name: string
        }[]
      ).map((r) => r.name)
      // v13 起插入路径同样并入脏队列：仅保留 FTS 同步触发器（insert/delete/update）
      expect(names).not.toContain('photos_search_insert')
      expect(names).not.toContain('album_photos_search_insert')
      expect(names).not.toContain('album_photos_search_delete')
      expect(names).not.toContain('albums_search_rename')
      expect(names).toEqual(
        expect.arrayContaining(['photos_fts_insert', 'photos_fts_delete', 'photos_fts_update']),
      )
    } finally {
      raw.close()
    }
  })

  it('大批量写入后在后台自动刷新，无需检索触发', async () => {
    const ids = bulkPhotos(600)
    const tag = db.createTag('后台刷新', null)
    db.batchTags(ids, [tag.id], [])

    const raw = new Database(path.join(userData, 'framora.db'), { readonly: true })
    try {
      const deadline = Date.now() + 3000
      let count = 0
      while (Date.now() < deadline) {
        count = (
          raw
            .prepare("SELECT COUNT(*) AS c FROM photos WHERE search_text LIKE '%后台刷新%'")
            .get() as { c: number }
        ).c
        if (count === 600) break
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(count).toBe(600)
    } finally {
      raw.close()
    }
  })

  it('导出备份前同步冲刷，备份内检索文本完整', async () => {
    const ids = bulkPhotos(600)
    const tag = db.createTag('导出冲刷', null)
    db.batchTags(ids, [tag.id], [])

    const dest = path.join(userData, 'flushed.db')
    await db.exportBackup(dest)
    const raw = new Database(dest, { readonly: true })
    try {
      const count = (
        raw
          .prepare("SELECT COUNT(*) AS c FROM photos WHERE search_text LIKE '%导出冲刷%'")
          .get() as { c: number }
      ).c
      expect(count).toBe(600)
    } finally {
      raw.close()
    }
  })

  it('关闭库前冲刷，重开后立即可检索', async () => {
    const ids = bulkPhotos(600)
    const tag = db.createTag('关闭冲刷', null)
    db.batchTags(ids, [tag.id], [])

    db.closeDb()
    await db.initDb()
    expect(db.queryPhotos({ scope: 'all', keyword: '关闭冲刷' }).total).toBe(600)
  })
})

describe('万级批量写基线', () => {
  it('标签 / 星级 / 相册 / 回收站保持线性量级', () => {
    const ids = bulkPhotos(10000, 'perf')
    const tag = db.createTag('性能标签', null)

    const t0 = performance.now()
    db.batchTags(ids, [tag.id], [])
    const tagMs = performance.now() - t0

    const t1 = performance.now()
    db.batchRate(ids, 4)
    const rateMs = performance.now() - t1

    const album = db.createAlbum('性能相册', null)
    const t2 = performance.now()
    db.batchAlbum(ids, album)
    const albumMs = performance.now() - t2

    // 检索前冲刷 1 万行 search_text + FTS
    const t3 = performance.now()
    expect(db.queryPhotos({ scope: 'all', keyword: '性能标签' }).total).toBe(10000)
    const searchMs = performance.now() - t3

    const t4 = performance.now()
    expect(db.softDeletePhotos(ids)).toBe(10000)
    const trashMs = performance.now() - t4

    console.log(
      `[batch] 10k: tags=${tagMs.toFixed(0)}ms rate=${rateMs.toFixed(0)}ms album=${albumMs.toFixed(0)}ms trash=${trashMs.toFixed(0)}ms flush+search=${searchMs.toFixed(0)}ms`,
    )
    expect(tagMs).toBeLessThan(2000)
    expect(rateMs).toBeLessThan(1000)
    expect(albumMs).toBeLessThan(1000)
    expect(trashMs).toBeLessThan(2000)
    expect(searchMs).toBeLessThan(5000)
  })
})
