/**
 * db.ts 核心回归测试：迁移、查询构建（作用域/关键词/筛选/排序/分页）、
 * FTS 触发器同步、智能相册、dupCache 失效语义。
 * 每个用例使用独立临时 userData 目录，避免跨用例状态污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let userData: string

vi.mock('electron', () => ({
  // getPath 仅在 initDb 等函数内被调用，届时 userData 已初始化
  app: { getPath: () => userData },
  dialog: { showMessageBoxSync: () => 0 }
}))

import * as db from '../src/main/db'

const IMPORT_TS = Date.parse('2026-01-01T00:00:00Z')

function seed(
  folderId: number,
  name: string,
  opts: {
    title?: string
    description?: string
    rating?: number
    size?: number
    takenAt?: number
    importedAt?: number
    missing?: boolean
  } = {}
): number {
  const id = db.insertPhoto({
    folder_id: folderId,
    path: `C:\\pics\\${name}.jpg`,
    name: `${name}.jpg`,
    ext: 'jpg',
    size: opts.size ?? 1000,
    mtime: 1,
    imported_at: opts.importedAt ?? IMPORT_TS
  })
  if (opts.title !== undefined || opts.description !== undefined) {
    db.updatePhotoMeta(id, { title: opts.title, description: opts.description })
  }
  if (opts.rating !== undefined) db.updatePhotoMeta(id, { rating: opts.rating })
  if (opts.takenAt !== undefined) db.setPhotoDimsAndDate(id, 100, 100, opts.takenAt)
  if (opts.missing) db.updatePhotoFileFields(id, { missing: 1 })
  return id
}

function newFolder(p: string): number {
  return db.addFolder(p, path.basename(p))
}

beforeEach(async () => {
  userData = mkdtempSync(path.join(tmpdir(), 'framora-db-test-'))
  await db.initDb()
  db.markPhashDirty()
})

afterEach(() => {
  db.closeDb()
  rmSync(userData, { recursive: true, force: true })
})

describe('迁移与设置', () => {
  it('重复 initDb 幂等，数据保留（user_version 不回退）', () => {
    db.setSetting('theme', 'dark')
    db.closeDb()
    return db.initDb().then(() => {
      expect(db.getSetting('theme')).toBe('dark')
    })
  })

  it('全部迁移执行完毕（v4 智能相册表、v5 phash 列可用）', () => {
    expect(db.listSmartAlbums()).toEqual([])
    const f = newFolder('C:\\pics')
    const id = seed(f, 'p0')
    db.setPhotoPhash(id, 7, 9) // v5 列存在
    expect(db.libraryStats().total).toBe(1)
  })
})

describe('queryPhotos 分页与总数', () => {
  it('limit/offset 正确切片且 total 为全量', () => {
    const f = newFolder('C:\\pics')
    for (let i = 0; i < 5; i++) seed(f, `p${i}`, { importedAt: IMPORT_TS + i })
    const p1 = db.queryPhotos({ scope: 'all', limit: 2, sort: 'imported', dir: 'asc' })
    expect(p1.items).toHaveLength(2)
    expect(p1.total).toBe(5)
    const p3 = db.queryPhotos({ scope: 'all', limit: 2, offset: 4, sort: 'imported', dir: 'asc' })
    expect(p3.items).toHaveLength(1)
    expect(p3.total).toBe(5)
  })

  it('queryPhotoIds 返回全部匹配 id（不受分页限制）', () => {
    const f = newFolder('C:\\pics')
    for (let i = 0; i < 3; i++) seed(f, `p${i}`)
    expect(db.queryPhotoIds({ scope: 'all' })).toHaveLength(3)
  })
})

describe('关键词检索（FTS + LIKE 双路径）', () => {
  it('≥3 字走 trigram FTS，命中文件名/标题/描述', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'IMG_1', { title: '樱花树下的小路' })
    seed(f, 'IMG_2', { description: '黄昏的海边' })
    seed(f, 'IMG_3')
    expect(db.queryPhotos({ scope: 'all', keyword: '樱花树' }).total).toBe(1)
    expect(db.queryPhotos({ scope: 'all', keyword: '海边' }).total).toBe(1)
    expect(db.queryPhotos({ scope: 'all', keyword: 'IMG_3' }).total).toBe(1)
  })

  it('<3 字回退 LIKE 子串匹配', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'IMG_1', { title: '猫' })
    expect(db.queryPhotos({ scope: 'all', keyword: '猫' }).total).toBe(1)
  })

  it('标签参与检索文本（setPhotoTags 后重算）', () => {
    const f = newFolder('C:\\pics')
    const id = seed(f, 'IMG_1')
    const tag = db.createTag('旅行记忆', null)
    db.setPhotoTags(id, [tag.id])
    expect(db.queryPhotos({ scope: 'all', keyword: '旅行记' }).total).toBe(1)
  })

  it('FTS 短语引号被转义，不触发语法错误', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'IMG_1', { title: 'normal' })
    expect(() => db.queryPhotos({ scope: 'all', keyword: '"破坏"' })).not.toThrow()
    expect(db.queryPhotos({ scope: 'all', keyword: '"破坏"' }).total).toBe(0)
  })

  it('删除照片后 FTS 同步移除（不再命中）', () => {
    const f = newFolder('C:\\pics')
    const id = seed(f, 'IMG_1', { title: '落日余晖很美' })
    expect(db.queryPhotos({ scope: 'all', keyword: '落日余晖' }).total).toBe(1)
    db.deletePhotoRows([id])
    expect(db.queryPhotos({ scope: 'all', keyword: '落日余晖' }).total).toBe(0)
  })
})

describe('作用域与筛选', () => {
  it('folder / album / tag / untagged / missing 作用域', () => {
    const f1 = newFolder('C:\\pics\\a')
    const f2 = newFolder('C:\\pics\\b')
    const id1 = seed(f1, 'a1')
    const id2 = seed(f2, 'b1')
    seed(f2, 'b2', { missing: true })

    expect(db.queryPhotos({ scope: 'folder', scopeId: f1 }).total).toBe(1)
    const album = db.createAlbum('精选', null)
    db.batchAlbum([id1, id2], album)
    expect(db.queryPhotos({ scope: 'album', scopeId: album }).total).toBe(2)
    const tag = db.createTag('人像', null)
    db.setPhotoTags(id1, [tag.id])
    expect(db.queryPhotos({ scope: 'tag', scopeId: tag.id }).total).toBe(1)
    expect(db.queryPhotos({ scope: 'untagged' }).total).toBe(2)
    expect(db.queryPhotos({ scope: 'missing' }).total).toBe(1)
  })

  it('minRating 与日期范围（COALESCE taken/imported）', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'r3', { rating: 3, takenAt: Date.parse('2026-03-10T12:00:00') })
    seed(f, 'r5', { rating: 5, takenAt: Date.parse('2026-05-10T12:00:00') })
    expect(db.queryPhotos({ scope: 'all', minRating: 4 }).total).toBe(1)
    expect(db.queryPhotos({ scope: 'all', dateFrom: '2026-04-01' }).total).toBe(1)
    expect(db.queryPhotos({ scope: 'all', dateFrom: '2026-01-01', dateTo: '2026-04-01' }).total).toBe(1)
  })
})

describe('排序', () => {
  it('name 按 NOCASE 升序', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'Bella')
    seed(f, 'apple')
    const items = db.queryPhotos({ scope: 'all', sort: 'name', dir: 'asc' }).items
    expect(items.map((p) => p.name)).toEqual(['apple.jpg', 'Bella.jpg'])
  })

  it('taken 排序使用 COALESCE(taken_at, imported_at)', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'noExif', { importedAt: Date.parse('2026-06-01T00:00:00Z') })
    seed(f, 'withExif', { takenAt: Date.parse('2020-01-01T00:00:00') })
    const items = db.queryPhotos({ scope: 'all', sort: 'taken', dir: 'asc' }).items
    expect(items[0].name).toBe('withExif.jpg')
  })
})

describe('智能相册（保存的搜索条件）', () => {
  it('scope=smart 应用保存的筛选条件', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'r5', { rating: 5, title: '海边日落' })
    seed(f, 'r2', { rating: 2, title: '雪山' })
    const sa = db.createSmartAlbum('高分海景', { minRating: 4, keyword: '海边日落' })
    const r = db.queryPhotos({ scope: 'smart', scopeId: sa })
    expect(r.total).toBe(1)
    expect(r.items[0].name).toBe('r5.jpg')
  })

  it('删除智能相册后列表移除', () => {
    const sa = db.createSmartAlbum('空条件', {})
    expect(db.listSmartAlbums().map((a) => a.id)).toContain(sa)
    db.deleteSmartAlbum(sa)
    expect(db.listSmartAlbums()).toHaveLength(0)
  })
})

describe('dupCache 失效语义（第一批修复回归）', () => {
  function dupPair(f: number, lo: number): [number, number] {
    const a = seed(f, `dup-${lo}-a`)
    const b = seed(f, `dup-${lo}-b`)
    db.setPhotoPhash(a, lo, 0)
    db.setPhotoPhash(b, lo, 0)
    return [a, b]
  }

  it('相同哈希聚为一簇；删除成员后缓存立即失效', async () => {
    const f = newFolder('C:\\pics')
    const [a, b] = dupPair(f, 1)
    expect((await db.duplicatePhotoIds()).sort()).toEqual([a, b].sort())
    db.deletePhotoRows([a])
    // 簇仅剩 1 名成员 → 不再视为重复（若缓存未失效此处仍为 2）
    expect(await db.duplicatePhotoIds()).toHaveLength(0)
  })

  it('标记 missing 后从重复簇排除', async () => {
    const f = newFolder('C:\\pics')
    const [, b] = dupPair(f, 2)
    expect(await db.duplicatePhotoIds()).toHaveLength(2)
    db.updatePhotoFileFields(b, { missing: 1 })
    expect(await db.duplicatePhotoIds()).toHaveLength(0)
    db.updatePhotoFileFields(b, { missing: 0 })
    expect(await db.duplicatePhotoIds()).toHaveLength(2)
  })

  it('移除资料库后其照片不再出现在重复结果', async () => {
    const f1 = newFolder('C:\\pics\\x')
    const f2 = newFolder('C:\\pics\\y')
    dupPair(f1, 3)
    dupPair(f2, 4)
    expect(await db.duplicatePhotoIds()).toHaveLength(4)
    db.removeFolderRows(f1)
    expect(await db.duplicatePhotoIds()).toHaveLength(2)
  })

  it('duplicateClusters 保留簇边界且与拍平 id 一致', async () => {
    const f = newFolder('C:\\pics')
    const [a, b] = dupPair(f, 0x00000000)
    // 第二簇用与 0 汉明距离 32 位的哈希，确保不与第一簇合并
    const c = seed(f, 'dup-2nd-a')
    const d = seed(f, 'dup-2nd-b')
    db.setPhotoPhash(c, 0xffffffff, 0xffffffff)
    db.setPhotoPhash(d, 0xffffffff, 0xffffffff)
    const clusters = await db.duplicateClusters()
    expect(clusters).toHaveLength(2)
    expect(clusters.every((x) => x.length === 2)).toBe(true)
    expect(clusters.flat().sort((x, y) => x - y)).toEqual(
      (await db.duplicatePhotoIds()).sort((x, y) => x - y)
    )
    expect(clusters.flat().sort((x, y) => x - y)).toEqual([a, b, c, d].sort((x, y) => x - y))
  })

  it('queryDuplicates 按簇顺序分页', async () => {
    const f = newFolder('C:\\pics')
    const [a, b] = dupPair(f, 5)
    const r = await db.queryDuplicates({ limit: 1 })
    expect(r.total).toBe(2)
    expect(r.items).toHaveLength(1)
    expect([a, b]).toContain(r.items[0].id)
  })
})
