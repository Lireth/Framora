import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import type {
  AlbumInfo,
  FolderInfo,
  PhotoLite,
  PhotoQuery,
  PhotoRecord,
  QueryResult,
  TagInfo,
  TagRef
} from '@shared/types'

let db: Database.Database

/** 预编译语句缓存：better-sqlite3 不缓存 prepare 结果，热路径重复编译有额外开销 */
const stmtCache = new Map<string, Database.Statement>()

function stmt(sql: string): Database.Statement {
  let s = stmtCache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    stmtCache.set(sql, s)
  }
  return s
}

/**
 * Schema 迁移列表：索引即目标 user_version。
 * - v1 为初始 schema，全部使用 IF NOT EXISTS，对已存在的旧库幂等。
 * - 后续 schema 变更一律追加新迁移函数，禁止修改历史迁移。
 */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  (db) => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      taken_at INTEGER,
      imported_at INTEGER NOT NULL,
      rating INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      description TEXT,
      orientation INTEGER NOT NULL DEFAULT 0,
      flip_h INTEGER NOT NULL DEFAULT 0,
      flip_v INTEGER NOT NULL DEFAULT 0,
      thumb_status INTEGER NOT NULL DEFAULT 0,
      thumb_ts INTEGER NOT NULL DEFAULT 0,
      missing INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id);
    CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at);
    CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating);
    CREATE INDEX IF NOT EXISTS idx_photos_missing ON photos(missing);
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT
    );
    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (photo_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_photo_tags_tag ON photo_tags(tag_id);
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS album_photos (
      album_id INTEGER NOT NULL,
      photo_id INTEGER NOT NULL,
      PRIMARY KEY (album_id, photo_id)
    );
    CREATE INDEX IF NOT EXISTS idx_album_photos_photo ON album_photos(photo_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  },
  // v2: 全文搜索 —— search_text 冗余列 + FTS5 trigram 外部内容表 + 同步触发器
  (db) => {
    db.exec(`ALTER TABLE photos ADD COLUMN search_text TEXT NOT NULL DEFAULT '';`)
    // 先回填存量数据（此时触发器尚未创建，避免产生无效 delete 条目）
    db.exec(`
      UPDATE photos SET search_text =
        name || ' ' || IFNULL(title, '') || ' ' || IFNULL(description, '') || ' ' ||
        IFNULL((SELECT group_concat(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                WHERE pt.photo_id = photos.id), '');
    `)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
        search_text, content='photos', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS photos_fts_insert AFTER INSERT ON photos BEGIN
        INSERT INTO photos_fts(rowid, search_text) VALUES (new.id, new.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS photos_fts_delete AFTER DELETE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS photos_fts_update AFTER UPDATE OF search_text ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
        INSERT INTO photos_fts(rowid, search_text) VALUES (new.id, new.search_text);
      END;
      CREATE TRIGGER IF NOT EXISTS photos_search_insert AFTER INSERT ON photos BEGIN
        UPDATE photos SET search_text =
          name || ' ' || IFNULL(title, '') || ' ' || IFNULL(description, '') || ' ' ||
          IFNULL((SELECT group_concat(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                  WHERE pt.photo_id = photos.id), '')
        WHERE id = new.id;
      END;
    `)
    // 从内容表全量重建 FTS 索引
    db.exec(`INSERT INTO photos_fts(photos_fts) VALUES ('rebuild');`)
  }
]

function migrate(): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = db.transaction(() => {
      MIGRATIONS[v](db)
      db.pragma(`user_version = ${v + 1}`)
    })
    step()
  }
}

export async function initDb(): Promise<void> {
  const userData = app.getPath('userData')
  fs.mkdirSync(path.join(userData, 'thumbs'), { recursive: true })
  fs.mkdirSync(path.join(userData, 'backups'), { recursive: true })
  db = new Database(path.join(userData, 'framora.db'))
  stmtCache.clear()
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  // 迁移前先备份当前库，升级失败可回滚
  await backupDatabase()
  migrate()
}

/**
 * 索引库滚动备份（迁移前调用），保留最近 DB_BACKUP_KEEP 份。
 * 使用 better-sqlite3 内置 backup API，对 WAL 库安全。
 */
const DB_BACKUP_KEEP = 3

export async function backupDatabase(): Promise<string | null> {
  const dir = path.join(app.getPath('userData'), 'db-backups')
  fs.mkdirSync(dir, { recursive: true })
  const version = db.pragma('user_version', { simple: true }) as number
  const file = path.join(dir, `framora-v${version}-${Date.now()}.db`)
  try {
    await db.backup(file)
  } catch {
    return null // 备份失败不阻塞启动
  }
  try {
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('framora-'))
      .sort((a, b) => b.localeCompare(a))
    for (const n of names.slice(DB_BACKUP_KEEP)) {
      fs.rmSync(path.join(dir, n), { force: true })
    }
  } catch {
    /* 清理失败忽略 */
  }
  return file
}

export function closeDb(): void {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
}

/* ---------- settings ---------- */

export function getSetting(key: string): string | null {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  stmt(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

/* ---------- folders ---------- */

export function listFolders(): FolderInfo[] {
  return stmt(
    `SELECT f.id, f.path, f.name, f.added_at,
      (SELECT COUNT(*) FROM photos p WHERE p.folder_id = f.id AND p.missing = 0) AS count
     FROM folders f ORDER BY f.added_at ASC`
  ).all() as FolderInfo[]
}

export function getFolderByPath(folderPath: string): FolderInfo | undefined {
  return stmt('SELECT * FROM folders WHERE path = ?').get(folderPath) as
    | FolderInfo
    | undefined
}

/** 已注册资料库文件夹路径（media 协议读取范围校验用） */
export function listFolderPaths(): string[] {
  const rows = stmt('SELECT path FROM folders').all() as { path: string }[]
  return rows.map((r) => r.path)
}

export function addFolder(folderPath: string, name: string): number {
  const info = stmt('INSERT OR IGNORE INTO folders (path, name, added_at) VALUES (?, ?, ?)')
    .run(folderPath, name, Date.now())
  if (info.changes > 0) return Number(info.lastInsertRowid)
  return getFolderByPath(folderPath)!.id
}

export function removeFolderRows(folderId: number): PhotoLite[] {
  const rows = stmt('SELECT * FROM photos WHERE folder_id = ?').all(folderId) as PhotoLite[]
  stmt(
    `DELETE FROM photo_tags WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`
  ).run(folderId)
  stmt(
    `DELETE FROM album_photos WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`
  ).run(folderId)
  stmt('DELETE FROM photos WHERE folder_id = ?').run(folderId)
  stmt('DELETE FROM folders WHERE id = ?').run(folderId)
  return rows
}

/* ---------- photos ---------- */

const PHOTO_LITE_COLS = `id, path, name, ext, size, folder_id, rating, width, height, taken_at,
  imported_at, thumb_status, thumb_ts, missing, orientation`

export function getPhotoRow(id: number): PhotoLite & { title: string | null; description: string | null; flip_h: number; flip_v: number; mtime: number } | undefined {
  return stmt(
    `SELECT ${PHOTO_LITE_COLS}, title, description, flip_h, flip_v, mtime FROM photos WHERE id = ?`
  ).get(id) as never
}

export function findPhotoByPath(photoPath: string): PhotoLite | undefined {
  return stmt(`SELECT ${PHOTO_LITE_COLS} FROM photos WHERE path = ?`).get(photoPath) as
    | PhotoLite
    | undefined
}

export function listPhotoRowsByFolder(folderId: number): { id: number; path: string; mtime: number; size: number; missing: number }[] {
  return stmt('SELECT id, path, mtime, size, missing FROM photos WHERE folder_id = ?')
    .all(folderId) as never
}

export function insertPhoto(p: {
  folder_id: number
  path: string
  name: string
  ext: string
  size: number
  mtime: number
  imported_at: number
}): number {
  const info = stmt(
    `INSERT INTO photos (folder_id, path, name, ext, size, mtime, imported_at)
     VALUES (@folder_id, @path, @name, @ext, @size, @mtime, @imported_at)`
  ).run(p)
  return Number(info.lastInsertRowid)
}

/** 批量插入（单事务），返回新照片 id 列表 */
export function insertPhotosBatch(
  rows: {
    folder_id: number
    path: string
    name: string
    ext: string
    size: number
    mtime: number
    imported_at: number
  }[]
): number[] {
  const run = db.transaction(() =>
    rows.map(
      (p) =>
        Number(
          stmt(
            `INSERT INTO photos (folder_id, path, name, ext, size, mtime, imported_at)
             VALUES (@folder_id, @path, @name, @ext, @size, @mtime, @imported_at)`
          ).run(p).lastInsertRowid
        )
    )
  )
  return run()
}

/** 批量更新文件字段（size/mtime/missing），单事务 */
export function updatePhotoFilesBatch(
  rows: { id: number; size?: number; mtime?: number; missing?: 0 | 1 }[]
): void {
  const run = db.transaction(() => {
    for (const r of rows) updatePhotoFileFields(r.id, r)
  })
  run()
}

const SEARCH_TEXT_EXPR = `
  name || ' ' || IFNULL(title, '') || ' ' || IFNULL(description, '') || ' ' ||
  IFNULL((SELECT group_concat(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.photo_id = photos.id), '')`

/** 重算照片的搜索文本（名称+标题+描述+标签名），FTS 触发器随之同步索引 */
export function recomputeSearchText(ids: number[]): void {
  if (!ids.length) return
  const run = db.transaction(() => {
    const up = stmt(`UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR} WHERE id = ?`)
    for (const id of ids) up.run(id)
  })
  run()
}

export function updatePhotoFileFields(
  id: number,
  fields: { size?: number; mtime?: number; missing?: 0 | 1 }
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (fields.size !== undefined) {
    sets.push('size = @size')
    params.size = fields.size
  }
  if (fields.mtime !== undefined) {
    sets.push('mtime = @mtime')
    params.mtime = fields.mtime
  }
  if (fields.missing !== undefined) {
    sets.push('missing = @missing')
    params.missing = fields.missing
  }
  if (!sets.length) return
  stmt(`UPDATE photos SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function setPhotoDimsAndDate(
  id: number,
  width: number | null,
  height: number | null,
  takenAt: number | null
): void {
  stmt('UPDATE photos SET width = ?, height = ?, taken_at = ? WHERE id = ?').run(
    width,
    height,
    takenAt,
    id
  )
}

export function setThumbStatus(id: number, status: 0 | 1 | 2, ts?: number): void {
  stmt('UPDATE photos SET thumb_status = ?, thumb_ts = ? WHERE id = ?').run(
    status,
    ts ?? Date.now(),
    id
  )
}

export function getPhotoRecord(id: number): PhotoRecord | undefined {
  const row = stmt(`SELECT ${PHOTO_LITE_COLS}, title, description, flip_h, flip_v, mtime FROM photos WHERE id = ?`)
    .get(id) as
    | (Omit<PhotoRecord, 'tags' | 'albums'>)
    | undefined
  if (!row) return undefined
  const tags = stmt(
    `SELECT t.id, t.name FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
     WHERE pt.photo_id = ? ORDER BY t.name`
  ).all(id) as TagRef[]
  const albums = stmt(
    `SELECT a.id, a.name FROM album_photos ap JOIN albums a ON a.id = ap.album_id
     WHERE ap.photo_id = ? ORDER BY a.name`
  ).all(id) as TagRef[]
  return { ...row, tags, albums }
}

export function updatePhotoMeta(
  id: number,
  patch: {
    rating?: number
    title?: string | null
    description?: string | null
    orientation?: number
    flip_h?: number
    flip_v?: number
  }
): void {
  const allowed: Record<string, unknown> = {}
  for (const k of ['rating', 'title', 'description', 'orientation', 'flip_h', 'flip_v'] as const) {
    if (patch[k] !== undefined) allowed[k] = patch[k]
  }
  const keys = Object.keys(allowed)
  if (!keys.length) return
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  stmt(`UPDATE photos SET ${sets} WHERE id = @id`).run({ id, ...allowed })
  if (patch.title !== undefined || patch.description !== undefined) recomputeSearchText([id])
}

export function deletePhotoRows(ids: number[]): void {
  const del = db.transaction((list: number[]) => {
    for (const id of list) {
      stmt('DELETE FROM photo_tags WHERE photo_id = ?').run(id)
      stmt('DELETE FROM album_photos WHERE photo_id = ?').run(id)
      stmt('DELETE FROM photos WHERE id = ?').run(id)
    }
  })
  del(ids)
}

/** 将 PhotoQuery 组装为 WHERE 子句与参数（queryPhotos / queryPhotoIds 共用） */
function buildPhotoFilter(q: PhotoQuery): { whereSql: string; params: Record<string, unknown> } {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  switch (q.scope) {
    case 'folder':
      where.push('p.folder_id = @scopeId')
      params.scopeId = q.scopeId
      break
    case 'album':
      where.push('EXISTS (SELECT 1 FROM album_photos ap WHERE ap.photo_id = p.id AND ap.album_id = @scopeId)')
      params.scopeId = q.scopeId
      break
    case 'tag':
      where.push('EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag_id = @scopeId)')
      params.scopeId = q.scopeId
      break
    case 'untagged':
      where.push('NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)')
      break
    case 'missing':
      where.push('p.missing = 1')
      break
    default:
      break
  }
  if (q.keyword && q.keyword.trim()) {
    const kw = q.keyword.trim()
    if (kw.length >= 3) {
      // trigram 分词支持任意 ≥3 字子串匹配（含中文）；短语包裹防 MATCH 语法注入
      where.push('p.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH @fts)')
      params.fts = `"${kw.replace(/"/g, '""')}"`
    } else {
      const like = `%${kw}%`
      where.push(
        `(p.name LIKE @kw OR IFNULL(p.title,'') LIKE @kw OR IFNULL(p.description,'') LIKE @kw
          OR EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                     WHERE pt.photo_id = p.id AND t.name LIKE @kw))`
      )
      params.kw = like
    }
  }
  if (q.dateFrom) {
    where.push('COALESCE(p.taken_at, p.imported_at) >= @dateFrom')
    params.dateFrom = new Date(`${q.dateFrom}T00:00:00`).getTime()
  }
  if (q.dateTo) {
    where.push('COALESCE(p.taken_at, p.imported_at) <= @dateTo')
    params.dateTo = new Date(`${q.dateTo}T23:59:59.999`).getTime()
  }
  if (q.minRating && q.minRating > 0) {
    where.push('p.rating >= @minRating')
    params.minRating = q.minRating
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

function buildOrderSql(q: PhotoQuery): string {
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC'
  if (q.scope === 'recent') return 'ORDER BY p.imported_at DESC, p.id DESC'
  switch (q.sort) {
    case 'name':
      return `ORDER BY p.name COLLATE NOCASE ${dir}, p.id ${dir}`
    case 'rating':
      return `ORDER BY p.rating ${dir}, p.id ${dir}`
    case 'size':
      return `ORDER BY p.size ${dir}, p.id ${dir}`
    case 'imported':
      return `ORDER BY p.imported_at ${dir}, p.id ${dir}`
    default:
      return `ORDER BY COALESCE(p.taken_at, p.imported_at) ${dir}, p.id ${dir}`
  }
}

export function queryPhotos(q: PhotoQuery): QueryResult {
  const { whereSql, params } = buildPhotoFilter(q)
  const orderSql = buildOrderSql(q)
  const limit = Math.min(q.limit ?? 50000, 100000)
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  // 窗口函数在单次查询中同时返回总数，避免额外的 COUNT 扫描
  const rows = stmt(
    `SELECT ${PHOTO_LITE_COLS}, COUNT(*) OVER() AS _total FROM photos p ${whereSql} ${orderSql} LIMIT ${limit} OFFSET ${offset}`
  ).all(params) as (PhotoLite & { _total?: number })[]
  let total: number
  if (rows.length) {
    total = Number(rows[0]._total ?? 0)
  } else if (offset > 0) {
    // 翻页越过末尾时窗口函数无行可读，退回显式 COUNT
    total = (stmt(`SELECT COUNT(*) AS c FROM photos p ${whereSql}`).get(params) as { c: number }).c
  } else {
    total = 0
  }
  const items = rows.map(({ _total: _t, ...p }) => p)
  return { items, total }
}

/** 返回匹配查询条件的全部照片 id（“全选”等批量操作用，不受分页限制） */
export function queryPhotoIds(q: PhotoQuery): number[] {
  const { whereSql, params } = buildPhotoFilter(q)
  const rows = stmt(`SELECT p.id FROM photos p ${whereSql} LIMIT 200000`).all(params) as {
    id: number
  }[]
  return rows.map((r) => r.id)
}

/* ---------- tags ---------- */

export function listTags(): TagInfo[] {
  return stmt(
    `SELECT t.id, t.name, t.color,
      (SELECT COUNT(*) FROM photo_tags pt WHERE pt.tag_id = t.id) AS count
     FROM tags t ORDER BY t.name COLLATE NOCASE`
  ).all() as TagInfo[]
}

export function createTag(name: string, color: string | null): TagInfo {
  const info = stmt('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)')
    .run(name, color)
  if (info.changes === 0) {
    throw new Error(`标签「${name}」已存在`)
  }
  return { id: Number(info.lastInsertRowid), name, color, count: 0 }
}

export function renameTag(id: number, name: string): void {
  const affected = (
    stmt('SELECT photo_id FROM photo_tags WHERE tag_id = ?').all(id) as { photo_id: number }[]
  ).map((r) => r.photo_id)
  stmt('UPDATE tags SET name = ? WHERE id = ?').run(name, id)
  recomputeSearchText(affected)
}

export function deleteTag(id: number): void {
  const affected = (
    stmt('SELECT photo_id FROM photo_tags WHERE tag_id = ?').all(id) as { photo_id: number }[]
  ).map((r) => r.photo_id)
  stmt('DELETE FROM photo_tags WHERE tag_id = ?').run(id)
  stmt('DELETE FROM tags WHERE id = ?').run(id)
  recomputeSearchText(affected)
}

export function setPhotoTags(photoId: number, tagIds: number[]): void {
  const run = db.transaction(() => {
    stmt('DELETE FROM photo_tags WHERE photo_id = ?').run(photoId)
    const ins = stmt('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)')
    for (const t of tagIds) ins.run(photoId, t)
  })
  run()
  recomputeSearchText([photoId])
}

export function batchTags(
  ids: number[],
  addTagIds: number[],
  removeTagIds: number[]
): void {
  const run = db.transaction(() => {
    const add = stmt('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)')
    const del = stmt('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?')
    for (const pid of ids) {
      for (const t of removeTagIds) del.run(pid, t)
      for (const t of addTagIds) add.run(pid, t)
    }
  })
  run()
  recomputeSearchText(ids)
}

export function batchRate(ids: number[], rating: number): void {
  const run = db.transaction(() => {
    const up = stmt('UPDATE photos SET rating = ? WHERE id = ?')
    for (const id of ids) up.run(rating, id)
  })
  run()
}

/* ---------- albums ---------- */

export function listAlbums(): AlbumInfo[] {
  return stmt(
    `SELECT a.id, a.name, a.color, a.created_at,
      (SELECT COUNT(*) FROM album_photos ap WHERE ap.album_id = a.id) AS count
     FROM albums a ORDER BY a.created_at ASC`
  ).all() as AlbumInfo[]
}

export function createAlbum(name: string, color: string | null): number {
  const info = stmt('INSERT INTO albums (name, color, created_at) VALUES (?, ?, ?)')
    .run(name, color, Date.now())
  return Number(info.lastInsertRowid)
}

export function renameAlbum(id: number, name: string): void {
  stmt('UPDATE albums SET name = ? WHERE id = ?').run(name, id)
}

export function deleteAlbum(id: number): void {
  stmt('DELETE FROM album_photos WHERE album_id = ?').run(id)
  stmt('DELETE FROM albums WHERE id = ?').run(id)
}

export function batchAlbum(ids: number[], albumId: number | null): void {
  const run = db.transaction(() => {
    if (albumId === null) {
      const del = stmt('DELETE FROM album_photos WHERE photo_id = ?')
      for (const id of ids) del.run(id)
    } else {
      const ins = stmt('INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?, ?)')
      for (const id of ids) ins.run(albumId, id)
    }
  })
  run()
}

export function removeFromAlbum(photoId: number, albumId: number): void {
  stmt('DELETE FROM album_photos WHERE photo_id = ? AND album_id = ?').run(photoId, albumId)
}

/* ---------- stats ---------- */

export function listPhotoIdsForRebuild(): number[] {
  const rows = stmt('SELECT id FROM photos WHERE missing = 0')
    .all() as { id: number }[]
  return rows.map((r) => r.id)
}

/** 上次退出时未完成缩略图生成的照片（用于启动续跑） */
export function listPhotoIdsPendingThumb(): number[] {
  const rows = stmt('SELECT id FROM photos WHERE thumb_status = 0 AND missing = 0')
    .all() as { id: number }[]
  return rows.map((r) => r.id)
}

/** 全量照片 id（孤儿缩略图清理用） */
export function listAllPhotoIds(): number[] {
  const rows = stmt('SELECT id FROM photos').all() as { id: number }[]
  return rows.map((r) => r.id)
}

export function libraryStats(): { total: number; missing: number; untagged: number } {
  const total = (stmt('SELECT COUNT(*) AS c FROM photos WHERE missing = 0').get() as { c: number }).c
  const missing = (stmt('SELECT COUNT(*) AS c FROM photos WHERE missing = 1').get() as { c: number }).c
  const untagged = (
    stmt(
      'SELECT COUNT(*) AS c FROM photos p WHERE p.missing = 0 AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)'
    ).get() as { c: number }
  ).c
  return { total, missing, untagged }
}
