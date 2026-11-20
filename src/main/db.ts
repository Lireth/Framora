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

export function initDb(): void {
  const userData = app.getPath('userData')
  fs.mkdirSync(path.join(userData, 'thumbs'), { recursive: true })
  fs.mkdirSync(path.join(userData, 'backups'), { recursive: true })
  db = new Database(path.join(userData, 'framora.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
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
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

/* ---------- folders ---------- */

export function listFolders(): FolderInfo[] {
  return db
    .prepare(
      `SELECT f.id, f.path, f.name, f.added_at,
        (SELECT COUNT(*) FROM photos p WHERE p.folder_id = f.id AND p.missing = 0) AS count
       FROM folders f ORDER BY f.added_at ASC`
    )
    .all() as FolderInfo[]
}

export function getFolderByPath(folderPath: string): FolderInfo | undefined {
  return db.prepare('SELECT * FROM folders WHERE path = ?').get(folderPath) as
    | FolderInfo
    | undefined
}

export function addFolder(folderPath: string, name: string): number {
  const info = db
    .prepare('INSERT OR IGNORE INTO folders (path, name, added_at) VALUES (?, ?, ?)')
    .run(folderPath, name, Date.now())
  if (info.changes > 0) return Number(info.lastInsertRowid)
  return getFolderByPath(folderPath)!.id
}

export function removeFolderRows(folderId: number): PhotoLite[] {
  const rows = db.prepare('SELECT * FROM photos WHERE folder_id = ?').all(folderId) as PhotoLite[]
  db.prepare(
    `DELETE FROM photo_tags WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`
  ).run(folderId)
  db.prepare(
    `DELETE FROM album_photos WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`
  ).run(folderId)
  db.prepare('DELETE FROM photos WHERE folder_id = ?').run(folderId)
  db.prepare('DELETE FROM folders WHERE id = ?').run(folderId)
  return rows
}

/* ---------- photos ---------- */

const PHOTO_LITE_COLS = `id, path, name, ext, size, folder_id, rating, width, height, taken_at,
  imported_at, thumb_status, thumb_ts, missing, orientation`

export function getPhotoRow(id: number): PhotoLite & { title: string | null; description: string | null; flip_h: number; flip_v: number; mtime: number } | undefined {
  return db
    .prepare(
      `SELECT ${PHOTO_LITE_COLS}, title, description, flip_h, flip_v, mtime FROM photos WHERE id = ?`
    )
    .get(id) as never
}

export function findPhotoByPath(photoPath: string): PhotoLite | undefined {
  return db.prepare(`SELECT ${PHOTO_LITE_COLS} FROM photos WHERE path = ?`).get(photoPath) as
    | PhotoLite
    | undefined
}

export function listPhotoRowsByFolder(folderId: number): { id: number; path: string; mtime: number; size: number; missing: number }[] {
  return db
    .prepare('SELECT id, path, mtime, size, missing FROM photos WHERE folder_id = ?')
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
  const info = db
    .prepare(
      `INSERT INTO photos (folder_id, path, name, ext, size, mtime, imported_at)
       VALUES (@folder_id, @path, @name, @ext, @size, @mtime, @imported_at)`
    )
    .run(p)
  return Number(info.lastInsertRowid)
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
  db.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function setPhotoDimsAndDate(
  id: number,
  width: number | null,
  height: number | null,
  takenAt: number | null
): void {
  db.prepare('UPDATE photos SET width = ?, height = ?, taken_at = ? WHERE id = ?').run(
    width,
    height,
    takenAt,
    id
  )
}

export function setThumbStatus(id: number, status: 0 | 1 | 2, ts?: number): void {
  db.prepare('UPDATE photos SET thumb_status = ?, thumb_ts = ? WHERE id = ?').run(
    status,
    ts ?? Date.now(),
    id
  )
}

export function getPhotoRecord(id: number): PhotoRecord | undefined {
  const row = db
    .prepare(`SELECT ${PHOTO_LITE_COLS}, title, description, flip_h, flip_v, mtime FROM photos WHERE id = ?`)
    .get(id) as
    | (Omit<PhotoRecord, 'tags' | 'albums'>)
    | undefined
  if (!row) return undefined
  const tags = db
    .prepare(
      `SELECT t.id, t.name FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.photo_id = ? ORDER BY t.name`
    )
    .all(id) as TagRef[]
  const albums = db
    .prepare(
      `SELECT a.id, a.name FROM album_photos ap JOIN albums a ON a.id = ap.album_id
       WHERE ap.photo_id = ? ORDER BY a.name`
    )
    .all(id) as TagRef[]
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
  db.prepare(`UPDATE photos SET ${sets} WHERE id = @id`).run({ id, ...allowed })
}

export function deletePhotoRows(ids: number[]): void {
  const del = db.transaction((list: number[]) => {
    for (const id of list) {
      db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(id)
      db.prepare('DELETE FROM album_photos WHERE photo_id = ?').run(id)
      db.prepare('DELETE FROM photos WHERE id = ?').run(id)
    }
  })
  del(ids)
}

export function queryPhotos(q: PhotoQuery): QueryResult {
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
    const kw = `%${q.keyword.trim()}%`
    where.push(
      `(p.name LIKE @kw OR IFNULL(p.title,'') LIKE @kw OR IFNULL(p.description,'') LIKE @kw
        OR EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                   WHERE pt.photo_id = p.id AND t.name LIKE @kw))`
    )
    params.kw = kw
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
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC'
  let orderSql = `ORDER BY COALESCE(p.taken_at, p.imported_at) ${dir}, p.id ${dir}`
  if (q.scope === 'recent') {
    orderSql = 'ORDER BY p.imported_at DESC, p.id DESC'
  } else if (q.sort === 'name') {
    orderSql = `ORDER BY p.name COLLATE NOCASE ${dir}, p.id ${dir}`
  } else if (q.sort === 'rating') {
    orderSql = `ORDER BY p.rating ${dir}, p.id ${dir}`
  } else if (q.sort === 'size') {
    orderSql = `ORDER BY p.size ${dir}, p.id ${dir}`
  } else if (q.sort === 'imported') {
    orderSql = `ORDER BY p.imported_at ${dir}, p.id ${dir}`
  }
  const limit = Math.min(q.limit ?? 50000, 100000)
  const items = db
    .prepare(`SELECT ${PHOTO_LITE_COLS} FROM photos p ${whereSql} ${orderSql} LIMIT ${limit}`)
    .all(params) as PhotoLite[]
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM photos p ${whereSql}`)
    .get(params) as { c: number }
  return { items, total: totalRow.c }
}

/* ---------- tags ---------- */

export function listTags(): TagInfo[] {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color,
        (SELECT COUNT(*) FROM photo_tags pt WHERE pt.tag_id = t.id) AS count
       FROM tags t ORDER BY t.name COLLATE NOCASE`
    )
    .all() as TagInfo[]
}

export function createTag(name: string, color: string | null): TagInfo {
  const info = db
    .prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)')
    .run(name, color)
  if (info.changes === 0) {
    const existed = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number }
    throw new Error(`标签「${name}」已存在`)
  }
  return { id: Number(info.lastInsertRowid), name, color, count: 0 }
}

export function renameTag(id: number, name: string): void {
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id)
}

export function deleteTag(id: number): void {
  db.prepare('DELETE FROM photo_tags WHERE tag_id = ?').run(id)
  db.prepare('DELETE FROM tags WHERE id = ?').run(id)
}

export function setPhotoTags(photoId: number, tagIds: number[]): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(photoId)
    const ins = db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)')
    for (const t of tagIds) ins.run(photoId, t)
  })
  run()
}

export function batchTags(
  ids: number[],
  addTagIds: number[],
  removeTagIds: number[]
): void {
  const run = db.transaction(() => {
    const add = db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)')
    const del = db.prepare('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?')
    for (const pid of ids) {
      for (const t of removeTagIds) del.run(pid, t)
      for (const t of addTagIds) add.run(pid, t)
    }
  })
  run()
}

export function batchRate(ids: number[], rating: number): void {
  const run = db.transaction(() => {
    const up = db.prepare('UPDATE photos SET rating = ? WHERE id = ?')
    for (const id of ids) up.run(rating, id)
  })
  run()
}

/* ---------- albums ---------- */

export function listAlbums(): AlbumInfo[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.color, a.created_at,
        (SELECT COUNT(*) FROM album_photos ap WHERE ap.album_id = a.id) AS count
       FROM albums a ORDER BY a.created_at ASC`
    )
    .all() as AlbumInfo[]
}

export function createAlbum(name: string, color: string | null): number {
  const info = db
    .prepare('INSERT INTO albums (name, color, created_at) VALUES (?, ?, ?)')
    .run(name, color, Date.now())
  return Number(info.lastInsertRowid)
}

export function renameAlbum(id: number, name: string): void {
  db.prepare('UPDATE albums SET name = ? WHERE id = ?').run(name, id)
}

export function deleteAlbum(id: number): void {
  db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(id)
  db.prepare('DELETE FROM albums WHERE id = ?').run(id)
}

export function batchAlbum(ids: number[], albumId: number | null): void {
  const run = db.transaction(() => {
    if (albumId === null) {
      const del = db.prepare('DELETE FROM album_photos WHERE photo_id = ?')
      for (const id of ids) del.run(id)
    } else {
      const ins = db.prepare('INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?, ?)')
      for (const id of ids) ins.run(albumId, id)
    }
  })
  run()
}

export function removeFromAlbum(photoId: number, albumId: number): void {
  db.prepare('DELETE FROM album_photos WHERE photo_id = ? AND album_id = ?').run(photoId, albumId)
}

/* ---------- stats ---------- */

export function listPhotoIdsForRebuild(): number[] {
  const rows = db
    .prepare('SELECT id FROM photos WHERE missing = 0')
    .all() as { id: number }[]
  return rows.map((r) => r.id)
}

export function libraryStats(): { total: number; missing: number; untagged: number } {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM photos WHERE missing = 0').get() as { c: number }).c
  const missing = (db.prepare('SELECT COUNT(*) AS c FROM photos WHERE missing = 1').get() as { c: number }).c
  const untagged = (
    db
      .prepare(
        'SELECT COUNT(*) AS c FROM photos p WHERE p.missing = 0 AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)'
      )
      .get() as { c: number }
  ).c
  return { total, missing, untagged }
}
