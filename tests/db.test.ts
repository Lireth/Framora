/**
 * db.ts 核心回归测试：迁移、查询构建（作用域/关键词/筛选/排序/分页）、
 * FTS 触发器同步、智能相册、dupCache 失效语义。
 * 每个用例使用独立临时 userData 目录，避免跨用例状态污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'

let userData: string

vi.mock('electron', () => ({
  // getPath 仅在 initDb 等函数内被调用，届时 userData 已初始化
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBoxSync: () => 0 },
}))

import * as db from '../src/main/db'
import { bumpThumbGeneration, enqueueThumb } from '../src/main/thumbs'
// 隔离相似哈希管线：缩略图成功后不再触发真实 phash 读取，
// 避免 Windows 下 afterEach 清理 userData 时拇指文件仍被句柄占用（EBUSY）
vi.mock('../src/main/phash', () => ({ enqueuePhash: vi.fn(), bumpPhashGeneration: vi.fn() }))

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
  } = {},
): number {
  const id = db.insertPhoto({
    folder_id: folderId,
    path: `C:\\pics\\${name}.jpg`,
    name: `${name}.jpg`,
    ext: 'jpg',
    size: opts.size ?? 1000,
    mtime: 1,
    imported_at: opts.importedAt ?? IMPORT_TS,
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
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    // Windows：刚写出的缩略图可能被杀软/句柄短暂锁定，延迟重试一次，仍失败留给临时目录自清理
    setTimeout(() => {
      try {
        rmSync(userData, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }, 500)
  }
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

describe('迁移守卫与备份策略', () => {
  it('版本号错位的历史库重跑迁移幂等（加列/触发器守卫生效）', async () => {
    const f = newFolder('C:\\pics')
    const id = seed(f, 'guard-1')
    db.closeDb()
    // 模拟 schema 领先、user_version 落后的历史库：迁移会重跑 v6..v8
    const raw = new Database(path.join(userData, 'framora.db'))
    raw.pragma('user_version = 5')
    raw.close()
    await db.initDb()
    // 数据保留，且 v8 相册名检索触发器重建后仍工作
    expect(db.libraryStats().total).toBe(1)
    const album = db.createAlbum('重跑相册', null)
    db.batchAlbum([id], album)
    expect(db.queryPhotos({ scope: 'all', keyword: '重跑相册' }).total).toBe(1)
  })

  it('损坏库（非数据库文件）被隔离并重建，原文件留存', async () => {
    db.closeDb()
    writeFileSync(path.join(userData, 'framora.db'), 'not a database at all')
    // SQLITE_NOTADB 属损坏类错误：自动隔离 + 重建，不应抛出
    await db.initDb()
    expect(db.libraryStats().total).toBe(0)
    const kept = readdirSync(userData).filter((n) => n.startsWith('framora.db.corrupt-'))
    expect(kept).toHaveLength(1)
  })

  it('仅实际发生迁移时备份；日常启动不重复备份', async () => {
    // beforeEach 的首次 initDb 执行 v1..v10 迁移 → 恰好一份迁移前备份
    const dir = path.join(userData, 'db-backups')
    expect(readdirSync(dir)).toHaveLength(1)
    db.closeDb()
    await db.initDb() // 已是最新版本，无迁移
    expect(readdirSync(dir)).toHaveLength(1)
  })
})

describe('缩略图续跑（O13）', () => {
  it('续跑清单包含未完成与历史失败行（status 0/2），排除缺失与已删行', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'pend-0')
    const b = seed(f, 'pend-2')
    seed(f, 'pend-missing', { missing: true })
    const d = seed(f, 'pend-del')
    db.setThumbStatus(b, 2)
    db.softDeletePhotos([d])
    expect(db.listPhotoIdsPendingThumb().sort()).toEqual([a, b].sort())
  })
})

describe('缩略图管线（O13 真实集成）', () => {
  /** 写入真实图片文件并入库（行路径指向真实文件，缩略图管线可直接处理） */
  async function makePhoto(
    folderId: number,
    name: string,
    opts: { orientation?: number } = {},
  ): Promise<number> {
    const imgPath = path.join(userData, name)
    const img = sharp({
      create: opts.orientation
        ? { width: 20, height: 40, channels: 3, background: '#7fb3d5' }
        : { width: 60, height: 40, channels: 3, background: '#7fb3d5' },
    })
    if (opts.orientation) img.withMetadata({ orientation: opts.orientation })
    await img.jpeg().toFile(imgPath)
    return db.insertPhoto({
      folder_id: folderId,
      path: imgPath,
      name,
      ext: 'jpg',
      size: 1000,
      mtime: 1,
      imported_at: IMPORT_TS,
    })
  }

  beforeEach(() => {
    mkdirSync(path.join(userData, 'thumbs'), { recursive: true })
  })

  it('入库宽高按 EXIF 方向换算为显示尺寸', async () => {
    const f = newFolder('C:\\pics')
    // 像素 20×40 + orientation 6（竖存横显）→ 显示尺寸 40×20
    const id = await makePhoto(f, 'orient-1.jpg', { orientation: 6 })
    enqueueThumb(id)
    await new Promise((r) => setTimeout(r, 250))
    const row = db.getPhotoRow(id)
    expect(row?.thumb_status).toBe(1)
    expect(row?.width).toBe(40)
    expect(row?.height).toBe(20)
    expect(existsSync(path.join(userData, 'thumbs', `${id}.webp`))).toBe(true)
  })

  it('瞬时失败自动退避重试直至成功', async () => {
    const f = newFolder('C:\\pics')
    const id = await makePhoto(f, 'retry-1.jpg')
    const imgPath = path.join(userData, 'retry-1.jpg')
    // 首次尝试时源文件暂不可见（模拟短暂占用/同步窗口）
    renameSync(imgPath, `${imgPath}.pending`)
    enqueueThumb(id)
    await new Promise((r) => setTimeout(r, 150))
    expect(db.getPhotoRow(id)?.thumb_status).toBe(0) // 退避中不进入失败态
    // 文件就位后退避重试成功
    renameSync(`${imgPath}.pending`, imgPath)
    await new Promise((r) => setTimeout(r, 1600))
    const row = db.getPhotoRow(id)
    expect(row?.thumb_status).toBe(1)
    expect(existsSync(path.join(userData, 'thumbs', `${id}.webp`))).toBe(true)
  })

  it('重试次数耗尽后进入失败态', async () => {
    const f = newFolder('C:\\pics')
    // ghost 路径：每次尝试都失败（首次 + 两次退避重试 1s/3s）
    const id = db.insertPhoto({
      folder_id: f,
      path: path.join(userData, 'ghost.jpg'),
      name: 'ghost.jpg',
      ext: 'jpg',
      size: 1,
      mtime: 1,
      imported_at: IMPORT_TS,
    })
    enqueueThumb(id)
    await new Promise((r) => setTimeout(r, 4500))
    expect(db.getPhotoRow(id)?.thumb_status).toBe(2)
  })

  it('换库后代次递增：在途缩略图任务写入作废', async () => {
    const f = newFolder('C:\\pics')
    const id = await makePhoto(f, 'gen-1.jpg')
    // run 在 enqueueThumb 内同步启动并捕获代次，随后递增使全部写入作废
    enqueueThumb(id)
    bumpThumbGeneration()
    await new Promise((r) => setTimeout(r, 200))
    const row = db.getPhotoRow(id)
    expect(row?.thumb_status).toBe(0)
    expect(existsSync(path.join(userData, 'thumbs', `${id}.webp`))).toBe(false)
  })
})

describe('路径大小写归一化', () => {
  it('路径等值匹配大小写不敏感（照片与文件夹）', () => {
    const f = newFolder('C:\\Pics')
    const id = seed(f, 'Case1')
    expect(db.findPhotoByPath('c:\\pics\\CASE1.JPG')?.id).toBe(id)
    // 变体重注册文件夹返回同一行，不产生重复资料库
    expect(db.addFolder('c:\\PICS', 'pics')).toBe(f)
    expect(db.listFolders()).toHaveLength(1)
  })

  it('批量插入对大小写冲突行幂等忽略，返回实际新增 id', () => {
    const f = newFolder('C:\\pics')
    seed(f, 'Dup1')
    const ids = db.insertPhotosBatch([
      {
        folder_id: f,
        path: 'C:\\pics\\dup1.jpg',
        name: 'dup1.jpg',
        ext: 'jpg',
        size: 1000,
        mtime: 1,
        imported_at: IMPORT_TS,
      },
      {
        folder_id: f,
        path: 'C:\\pics\\fresh2.jpg',
        name: 'fresh2.jpg',
        ext: 'jpg',
        size: 1000,
        mtime: 1,
        imported_at: IMPORT_TS,
      },
    ])
    expect(ids).toHaveLength(1)
    expect(db.libraryStats().total).toBe(2)
  })

  it('v9 迁移合并大小写重复行并建立唯一约束', async () => {
    const f = newFolder('C:\\pics')
    seed(f, 'Case1')
    db.closeDb()
    // 绕过应用层注入大小写变体重复行：先移除 CI 索引模拟 v9 之前的历史库，
    // 再将 user_version 回退到 8，让 initDb 重跑 v9 迁移
    const raw = new Database(path.join(userData, 'framora.db'))
    raw.exec('DROP INDEX IF EXISTS idx_photos_path_ci; DROP INDEX IF EXISTS idx_folders_path_ci;')
    raw
      .prepare(
        `INSERT INTO photos (folder_id, path, name, ext, size, mtime, imported_at, search_text)
         VALUES (?, ?, ?, 'jpg', 1000, 1, ?, '')`,
      )
      .run(f, 'C:\\PICS\\case1.jpg', 'case1.jpg', IMPORT_TS)
    raw.pragma('user_version = 8')
    raw.close()
    await db.initDb()
    // 重复行被合并：保留最早未删除行，检索仍按大小写不敏感命中
    expect(db.libraryStats().total).toBe(1)
    expect(db.findPhotoByPath('c:\\pics\\CASE1.JPG')).toBeDefined()
    // 大小写不敏感唯一索引生效（BINARY 索引拦不住该变体）
    expect(() =>
      db.insertPhoto({
        folder_id: f,
        path: 'C:\\Pics\\case1.jpg',
        name: 'case1.jpg',
        ext: 'jpg',
        size: 1,
        mtime: 1,
        imported_at: IMPORT_TS,
      }),
    ).toThrow()
    // 回收站按路径还原同样大小写不敏感
    db.softDeletePhotos([db.findPhotoByPath('C:\\pics\\Case1.jpg')!.id])
    expect(db.findDeletedPhotoId('C:\\PICS\\CASE1.jpg')).not.toBeNull()
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

  it('相册名参与检索（成员变更与重命名经触发器联动）', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'IMG_1')
    seed(f, 'IMG_2')
    const album = db.createAlbum('海边旅拍', null)
    db.batchAlbum([a], album)
    // ≥3 字走 FTS：命中相册名，且未入相册的照片不误中
    expect(db.queryPhotos({ scope: 'all', keyword: '海边旅拍' }).total).toBe(1)
    // <3 字走 LIKE：对 search_text 冗余列匹配，同样命中相册名
    expect(db.queryPhotos({ scope: 'all', keyword: '旅拍' }).total).toBe(1)
    // 相册重命名后旧名不再命中、新名命中（albums_search_rename 触发器）
    db.renameAlbum(album, '雪山旅拍')
    expect(db.queryPhotos({ scope: 'all', keyword: '海边旅拍' }).total).toBe(0)
    expect(db.queryPhotos({ scope: 'all', keyword: '雪山旅拍' }).total).toBe(1)
    // 移出相册后不再命中（album_photos_search_delete 触发器）
    db.removeFromAlbum(a, album)
    expect(db.queryPhotos({ scope: 'all', keyword: '雪山旅拍' }).total).toBe(0)
    // 智能相册的关键词条件共享同一过滤管线
    const sa = db.createSmartAlbum('雪山智能', { keyword: '雪山旅拍' })
    db.batchAlbum([a], album)
    expect(db.queryPhotos({ scope: 'smart', scopeId: sa }).items[0].id).toBe(a)
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
    expect(
      db.queryPhotos({ scope: 'all', dateFrom: '2026-01-01', dateTo: '2026-04-01' }).total,
    ).toBe(1)
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

  it('默认排序走 sort_ts 物化列，随 taken_at 更新自动跟随', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'may', { takenAt: Date.parse('2026-05-01T00:00:00'), importedAt: IMPORT_TS })
    const b = seed(f, 'jan', { importedAt: Date.parse('2026-01-10T00:00:00Z') })
    // taken_at 缺失时 sort_ts 回退导入时间（b=1 月 < a=5 月），desc 下 a 在前
    expect(
      db.queryPhotos({ scope: 'all', sort: 'taken', dir: 'desc' }).items.map((p) => p.id),
    ).toEqual([a, b])
    // 生成列随源列自动跟随，无需显式重算
    db.setPhotoDimsAndDate(a, 100, 100, Date.parse('2025-12-01T00:00:00'))
    expect(
      db.queryPhotos({ scope: 'all', sort: 'taken', dir: 'desc' }).items.map((p) => p.id),
    ).toEqual([b, a])
  })

  it('默认排序查询命中 sort_ts 索引（免全量重排）', async () => {
    const f = newFolder('C:\\pics')
    seed(f, 'plan-1')
    db.closeDb()
    const raw = new Database(path.join(userData, 'framora.db'))
    const plan = raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM photos
         WHERE deleted_at IS NULL ORDER BY sort_ts DESC, id DESC LIMIT 500 OFFSET 0`,
      )
      .all() as { detail: string }[]
    raw.close()
    await db.initDb()
    expect(plan.some((p) => p.detail.includes('idx_photos_sort_ts'))).toBe(true)
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
    db.softRemoveFolder(f1)
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
      (await db.duplicatePhotoIds()).sort((x, y) => x - y),
    )
    expect(clusters.flat().sort((x, y) => x - y)).toEqual([a, b, c, d].sort((x, y) => x - y))
  })

  it('哈希持续置脏时复用同一在途聚类，不排队叠加全量计算', async () => {
    const f = newFolder('C:\\pics')
    dupPair(f, 7)
    const p1 = db.duplicateClusters()
    db.markPhashDirty()
    const p2 = db.duplicateClusters()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    // 结果代次已过期，不写入缓存：下一次查询必须重算
    expect(await db.duplicateClusters()).not.toBe(r1)
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

describe('回收站（软删除）语义', () => {
  it('软删除后所有常规视图不可见，回收站可见；还原后回到原位', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'del-1', { takenAt: Date.parse('2026-03-01') })
    const b = seed(f, 'keep-1', { takenAt: Date.parse('2026-03-02') })

    expect(db.softDeletePhotos([a])).toBe(1)
    // 常规视图排除已删行
    expect(db.queryPhotos({ scope: 'all' }).total).toBe(1)
    expect(db.queryPhotoIds({ scope: 'all' })).toEqual([b])
    expect(db.queryPhotos({ scope: 'folder', scopeId: f }).total).toBe(1)
    // 回收站视图只含已删行，按删除时间倒序
    const trash = db.queryPhotos({ scope: 'trash' })
    expect(trash.total).toBe(1)
    expect(trash.items[0].id).toBe(a)
    // 统计口径
    const stats = db.libraryStats()
    expect(stats.total).toBe(1)
    expect(stats.trash).toBe(1)

    // 还原后回到原作用域
    expect(db.restorePhotos([a])).toBe(1)
    expect(db.queryPhotos({ scope: 'all' }).total).toBe(2)
    expect(db.libraryStats().trash).toBe(0)
  })

  it('重复软删除幂等，还原未删除项计 0', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'del-2')
    expect(db.softDeletePhotos([a])).toBe(1)
    expect(db.softDeletePhotos([a])).toBe(0)
    expect(db.restorePhotos([a])).toBe(1)
    expect(db.restorePhotos([a])).toBe(0)
  })

  it('已删行不参与相似聚类与缩略图重建，孤儿清理仍保留其缩略图', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'dup-soft-a')
    const b = seed(f, 'dup-soft-b')
    const c = seed(f, 'dup-soft-c')
    db.setPhotoPhash(a, 123, 0)
    db.setPhotoPhash(b, 123, 0)
    db.setPhotoPhash(c, 123, 0)

    db.softDeletePhotos([a])
    return db.duplicatePhotoIds().then((ids) => {
      // 剩余 b/c 仍构成一簇，已删的 a 不参与
      expect(ids.sort()).toEqual([b, c].sort())
      // 重建与续跑排除已删行
      expect(db.listPhotoIdsForRebuild().sort()).toEqual([b, c].sort())
      expect(db.listPhotoIdsPendingThumb().sort()).toEqual([b, c].sort())
      // 孤儿清理的全量 id 集合包含已删行（其缩略图在还原时需可用）
      expect(db.listAllPhotoIds()).toHaveLength(3)
    })
  })

  it('listDeletedRows / findDeletedPhotoId 安全过滤', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'del-3')
    const b = seed(f, 'del-4')
    db.softDeletePhotos([a])

    expect(db.findDeletedPhotoId('C:\\pics\\del-3.jpg')).toBe(a)
    expect(db.findDeletedPhotoId('C:\\pics\\del-4.jpg')).toBeNull()
    // purge 安全过滤：只返回已删行
    expect(db.listDeletedRows([a, b]).map((r) => r.id)).toEqual([a])
    expect(db.listAllDeletedRows()).toHaveLength(1)
  })

  it('文件夹/相册/标签计数排除已删行', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'cnt-1')
    seed(f, 'cnt-2')
    const tag = db.createTag('计数标签', null)
    db.setPhotoTags(a, [tag.id])
    const album = db.createAlbum('计数相册', null)
    db.batchAlbum([a], album)

    db.softDeletePhotos([a])
    expect(db.listFolders()[0].count).toBe(1)
    expect(db.listTags()[0].count).toBe(0)
    expect(db.listAlbums()[0].count).toBe(0)
    expect(db.listAlbums()[0].cover_id == null).toBe(true)
  })
})

describe('元数据软删除与撤销（P0-1）', () => {
  it('删除标签后从列表/照片/检索中消失，恢复后关系与检索回到原状', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'meta-tag-a')
    const tag = db.createTag('旅行', '#fff')
    db.setPhotoTags(a, [tag.id])
    expect(db.queryPhotos({ scope: 'all', keyword: '旅行' }).total).toBe(1)

    expect(db.deleteTag(tag.id)).toEqual({ name: '旅行', photos: 1 })
    expect(db.listTags()).toHaveLength(0)
    expect(db.getPhotoRecord(a)?.tags).toHaveLength(0)
    // 标签名从检索文本中移除，照片回到未加标签
    expect(db.queryPhotos({ scope: 'all', keyword: '旅行' }).total).toBe(0)
    expect(db.queryPhotos({ scope: 'untagged' }).total).toBe(1)

    expect(db.restoreTag(tag.id)?.name).toBe('旅行')
    expect(db.listTags()).toHaveLength(1)
    expect(db.getPhotoRecord(a)?.tags[0]?.name).toBe('旅行')
    expect(db.queryPhotos({ scope: 'all', keyword: '旅行' }).total).toBe(1)
    expect(db.queryPhotos({ scope: 'untagged' }).total).toBe(0)
  })

  it('同名新建标签复活软删除行并保留照片关系', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'meta-tag-b')
    const tag = db.createTag('夜景', null)
    db.setPhotoTags(a, [tag.id])
    db.deleteTag(tag.id)

    const again = db.createTag('夜景', null)
    expect(again.id).toBe(tag.id)
    expect(db.listTags()).toHaveLength(1)
    expect(db.getPhotoRecord(a)?.tags.map((t) => t.name)).toEqual(['夜景'])
  })

  it('软删除标签的关联在编辑可见标签后仍保留，撤销时原样恢复', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'meta-tag-c')
    const oldTag = db.createTag('旅行', null)
    db.setPhotoTags(a, [oldTag.id])
    db.deleteTag(oldTag.id)

    const other = db.createTag('人像', null)
    db.setPhotoTags(a, [other.id])
    expect(db.getPhotoRecord(a)?.tags.map((t) => t.name)).toEqual(['人像'])

    db.restoreTag(oldTag.id)
    expect(
      db
        .getPhotoRecord(a)
        ?.tags.map((t) => t.name)
        .sort(),
    ).toEqual(['人像', '旅行'].sort())
  })

  it('删除相册后成员关系保留，恢复后计数与作用域回到原状', () => {
    const f = newFolder('C:\\pics')
    const a = seed(f, 'meta-album-a')
    const album = db.createAlbum('精选', null)
    db.batchAlbum([a], album)
    expect(db.listAlbums()[0].count).toBe(1)

    expect(db.deleteAlbum(album)).toEqual({ name: '精选', photos: 1 })
    expect(db.listAlbums()).toHaveLength(0)
    expect(db.getPhotoRecord(a)?.albums).toHaveLength(0)
    expect(db.queryPhotos({ scope: 'album', scopeId: album }).total).toBe(0)
    // 相册名从检索文本中移除
    expect(db.queryPhotos({ scope: 'all', keyword: '精选' }).total).toBe(0)

    expect(db.restoreAlbum(album)?.name).toBe('精选')
    expect(db.listAlbums()[0].count).toBe(1)
    expect(db.getPhotoRecord(a)?.albums[0]?.name).toBe('精选')
    expect(db.queryPhotos({ scope: 'album', scopeId: album }).total).toBe(1)
    expect(db.queryPhotos({ scope: 'all', keyword: '精选' }).total).toBe(1)
  })

  it('移除文件夹后照片从全部视图/统计/重复聚类中隐藏，恢复后回归', async () => {
    const f1 = newFolder('C:\\pics\\keep')
    const f2 = newFolder('C:\\pics\\hidden')
    const a = seed(f1, 'meta-folder-keep')
    const b = seed(f2, 'meta-folder-hidden')
    const tag = db.createTag('旅行', null)
    db.setPhotoTags(a, [tag.id])
    const album = db.createAlbum('精选', null)
    db.batchAlbum([a], album)
    db.setPhotoPhash(a, 10, 0)
    db.setPhotoPhash(b, 10, 0)

    expect(db.libraryStats().total).toBe(2)
    expect((await db.duplicatePhotoIds()).sort((x, y) => x - y)).toEqual(
      [a, b].sort((x, y) => x - y),
    )

    expect(db.softRemoveFolder(f2)).toEqual({ name: 'hidden', photos: 1 })
    expect(db.listFolders()).toHaveLength(1)
    expect(db.libraryStats().total).toBe(1)
    expect(db.queryPhotos({ scope: 'all' }).items.map((p) => p.id)).toEqual([a])
    // 隐藏文件夹中的照片不参与重复聚类：剩余单张不成簇
    expect(await db.duplicatePhotoIds()).toEqual([])
    expect(db.listTags()[0].count).toBe(1)
    expect(db.listAlbums()[0].count).toBe(1)

    expect(db.restoreFolder(f2)?.path).toBe('C:\\pics\\hidden')
    expect(db.listFolders()).toHaveLength(2)
    expect(db.libraryStats().total).toBe(2)
    expect(db.queryPhotos({ scope: 'all' }).total).toBe(2)
    expect((await db.duplicatePhotoIds()).sort((x, y) => x - y)).toEqual(
      [a, b].sort((x, y) => x - y),
    )
  })
})
