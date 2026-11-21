import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { app, dialog } from 'electron'
import { computePhashClusters } from './phashCluster'
import type {
  AlbumInfo,
  FolderInfo,
  PhotoLite,
  PhotoQuery,
  PhotoRecord,
  QueryResult,
  SmartAlbumInfo,
  SmartAlbumQuery,
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
 * - 每步迁移整体包在事务中（见 migrate），失败即回滚且 user_version 不推进。
 */
function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  columnDef: string
): void {
  // 用 table_xinfo 而非 table_info：生成列（GENERATED ALWAYS AS）只出现在 xinfo 中
  const cols = database.pragma(`table_xinfo(${table})`) as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`)
  }
}

/** 是否 SQLite 损坏类错误：仅此类错误才允许隔离重建，其余错误必须保留现场向上抛出 */
function isCorruptError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
}

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
    addColumnIfMissing(db, 'photos', 'search_text', "TEXT NOT NULL DEFAULT ''")
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
        INSERT INTO photos_fts(rowid, search_text)
          SELECT new.id, new.search_text WHERE new.search_text <> '';
      END;
      CREATE TRIGGER IF NOT EXISTS photos_fts_delete AFTER DELETE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, search_text)
          SELECT 'delete', old.id, old.search_text WHERE old.search_text <> '';
      END;
      CREATE TRIGGER IF NOT EXISTS photos_fts_update AFTER UPDATE OF search_text ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, search_text)
          SELECT 'delete', old.id, old.search_text WHERE old.search_text <> '';
        INSERT INTO photos_fts(rowid, search_text)
          SELECT new.id, new.search_text WHERE new.search_text <> '';
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
  },
  // v3: 修复 FTS 触发器 —— 外部内容表的 'delete' 命令禁止作用于从未索引的空文档，
  //     否则静默损坏索引（表现为后续写入报 "database disk image is malformed"）。
  //     空值不入索引、空值不发 delete；并对已迁移的存量库重建索引。
  (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS photos_fts_insert;
      DROP TRIGGER IF EXISTS photos_fts_delete;
      DROP TRIGGER IF EXISTS photos_fts_update;
      DROP TRIGGER IF EXISTS photos_search_insert;
      CREATE TRIGGER photos_fts_insert AFTER INSERT ON photos BEGIN
        INSERT INTO photos_fts(rowid, search_text)
          SELECT new.id, new.search_text WHERE new.search_text <> '';
      END;
      CREATE TRIGGER photos_fts_delete AFTER DELETE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, search_text)
          SELECT 'delete', old.id, old.search_text WHERE old.search_text <> '';
      END;
      CREATE TRIGGER photos_fts_update AFTER UPDATE OF search_text ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, search_text)
          SELECT 'delete', old.id, old.search_text WHERE old.search_text <> '';
        INSERT INTO photos_fts(rowid, search_text)
          SELECT new.id, new.search_text WHERE new.search_text <> '';
      END;
      CREATE TRIGGER photos_search_insert AFTER INSERT ON photos BEGIN
        UPDATE photos SET search_text =
          name || ' ' || IFNULL(title, '') || ' ' || IFNULL(description, '') || ' ' ||
          IFNULL((SELECT group_concat(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                  WHERE pt.photo_id = photos.id), '')
        WHERE id = new.id;
      END;
    `)
    db.exec(`INSERT INTO photos_fts(photos_fts) VALUES ('rebuild');`)
  },
  // v4: 智能相册（保存的搜索条件）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS smart_albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT,
        query TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  },
  // v5: 感知哈希列（相似照片检测）
  (db) => {
    addColumnIfMissing(db, 'photos', 'phash_lo', 'INTEGER')
    addColumnIfMissing(db, 'photos', 'phash_hi', 'INTEGER')
  },
  // v6: 高频排序列补索引（导入时间 / 文件名大小写无关），避免大库排序全表扫描
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_photos_imported ON photos(imported_at);
      CREATE INDEX IF NOT EXISTS idx_photos_name ON photos(name COLLATE NOCASE);
    `)
  },
  // v7: 软删除回收站（deleted_at 为空表示未删除）；部分索引仅为回收站视图加速
  (db) => {
    addColumnIfMissing(db, 'photos', 'deleted_at', 'INTEGER')
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_photos_trash ON photos(deleted_at) WHERE deleted_at IS NOT NULL;
    `)
  },
  // v8: 相册名参与检索 —— search_text 纳入相册名；成员变更与相册重命名经触发器联动重算
  //     （FTS 外部内容表的 photos_fts_update 触发器随后自动同步索引），
  //     存量库重算全部搜索文本并重建索引
  (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS album_photos_search_insert;
      DROP TRIGGER IF EXISTS album_photos_search_delete;
      DROP TRIGGER IF EXISTS albums_search_rename;
      CREATE TRIGGER album_photos_search_insert AFTER INSERT ON album_photos BEGIN
        UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR} WHERE id = new.photo_id;
      END;
      CREATE TRIGGER album_photos_search_delete AFTER DELETE ON album_photos BEGIN
        UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR} WHERE id = old.photo_id;
      END;
      CREATE TRIGGER albums_search_rename AFTER UPDATE OF name ON albums BEGIN
        UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR}
          WHERE id IN (SELECT photo_id FROM album_photos WHERE album_id = new.id);
      END;
    `)
    db.exec(`UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR};`)
    db.exec(`INSERT INTO photos_fts(photos_fts) VALUES ('rebuild');`)
  },
  // v9: 路径大小写归一化 —— Windows 文件系统不区分大小写，仅改大小写的重命名
  //     不得产生重复行。先合并历史遗留的大小写重复（重复文件夹下照片归入保留行；
  //     重复照片行保留优先未删除中最早的一张，冗余行的标签/相册引用一并清理），
  //     再建立大小写不敏感唯一索引；路径等值查询统一 COLLATE NOCASE
  (db) => {
    db.exec(`
      UPDATE photos SET folder_id = (
        SELECT MIN(k.id) FROM folders k
        WHERE k.path = (SELECT f.path FROM folders f WHERE f.id = photos.folder_id) COLLATE NOCASE
      )
      WHERE folder_id NOT IN (SELECT MIN(id) FROM folders GROUP BY path COLLATE NOCASE);
      DELETE FROM folders WHERE id NOT IN (SELECT MIN(id) FROM folders GROUP BY path COLLATE NOCASE);
      DELETE FROM photo_tags WHERE photo_id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (
          PARTITION BY path COLLATE NOCASE ORDER BY deleted_at IS NOT NULL, id
        ) AS rn FROM photos) WHERE rn > 1);
      DELETE FROM album_photos WHERE photo_id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (
          PARTITION BY path COLLATE NOCASE ORDER BY deleted_at IS NOT NULL, id
        ) AS rn FROM photos) WHERE rn > 1);
      DELETE FROM photos WHERE id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (
          PARTITION BY path COLLATE NOCASE ORDER BY deleted_at IS NOT NULL, id
        ) AS rn FROM photos) WHERE rn > 1);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_path_ci ON photos(path COLLATE NOCASE);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_path_ci ON folders(path COLLATE NOCASE);
    `)
  },
  // v10: 默认排序物化 —— sort_ts 生成列（VIRTUAL：随 taken_at/imported_at 自动跟随，零写放大）
  //      + 索引，默认排序翻页由索引直接供序（双向均可反向扫描），万级数据免全量重排；
  //      同时补齐 size 排序索引（rating/name/imported 在 v1/v6 已有）
  (db) => {
    addColumnIfMissing(
      db,
      'photos',
      'sort_ts',
      'INTEGER GENERATED ALWAYS AS (COALESCE(taken_at, imported_at)) VIRTUAL'
    )
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_photos_sort_ts ON photos(sort_ts);
      CREATE INDEX IF NOT EXISTS idx_photos_size ON photos(size);
    `)
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
  try {
    await openAndMigrate()
  } catch (err) {
    // 非损坏错误（迁移代码缺陷、磁盘满等）：保留现场与迁移前备份，向上抛出由
    // 入口弹窗提示后退出——绝不吞掉含标签/相册的整库
    if (!isCorruptError(err)) throw err
    // SQLite 损坏：隔离库文件（含 wal/shm）并重建空库，照片文件本体不受影响
    quarantineCorruptDb()
    dialog.showMessageBoxSync({
      type: 'warning',
      title: '拾帧 Framora',
      message: '照片索引库损坏，已自动备份损坏文件并重建空库。',
      detail: `照片文件不受影响，请重新导入文件夹恢复索引。\n\n错误信息：${err instanceof Error ? err.message : String(err)}`
    })
    await openAndMigrate()
  }
}

async function openAndMigrate(): Promise<void> {
  db = new Database(path.join(app.getPath('userData'), 'framora.db'))
  stmtCache.clear()
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  // 仅在确有迁移要执行时先备份（失败可回滚）；日常启动不再整库复制拖慢启动
  const current = db.pragma('user_version', { simple: true }) as number
  if (current < MIGRATIONS.length) {
    await backupDatabase()
  }
  migrate()
}

/** 关闭句柄并将损坏的库文件（含 wal/shm）改名留存 */
function quarantineCorruptDb(): void {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  const stamp = Date.now()
  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(app.getPath('userData'), `framora.db${suffix}`)
    try {
      if (fs.existsSync(src)) fs.renameSync(src, `${src}.corrupt-${stamp}`)
    } catch {
      /* ignore */
    }
  }
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
    // 按 mtime 新旧排序轮换：文件名内嵌的版本号位数不定（v2 与 v10），
    // 字典序会错排导致最新备份落入删除区间
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('framora-'))
      .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.n)
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

/** 导出当前索引库为单文件备份（better-sqlite3 backup API，对 WAL 安全） */
export async function exportBackup(destFile: string): Promise<void> {
  await db.backup(destFile)
}

/**
 * 用备份文件替换当前索引库：校验 → 保留现库为 .pre-import-<ts> → 复制 → 重开并迁移。
 * 照片文件本体不受影响；导入后调用方需重挂 watcher 并补建缺失缩略图。
 */
export async function importBackup(srcFile: string): Promise<void> {
  const probe = new Database(srcFile, { readonly: true })
  try {
    const t = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'")
      .get()
    if (!t) throw new Error('所选文件不是有效的 Framora 索引库备份')
  } finally {
    probe.close()
  }
  closeDb()
  const target = path.join(app.getPath('userData'), 'framora.db')
  const stamp = Date.now()
  for (const suffix of ['', '-wal', '-shm']) {
    const src = target + suffix
    try {
      if (fs.existsSync(src)) fs.renameSync(src, `${target}.pre-import-${stamp}${suffix}`)
    } catch {
      /* 单个改名失败不阻塞导入 */
    }
  }
  fs.copyFileSync(srcFile, target)
  await openAndMigrate()
  markPhashDirty()
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
      (SELECT COUNT(*) FROM photos p WHERE p.folder_id = f.id AND p.missing = 0 AND p.deleted_at IS NULL) AS count
     FROM folders f ORDER BY f.added_at ASC`
  ).all() as FolderInfo[]
}

export function getFolderByPath(folderPath: string): FolderInfo | undefined {
  // 路径匹配大小写不敏感（Windows FS 语义），走 idx_folders_path_ci
  return stmt('SELECT * FROM folders WHERE path = ? COLLATE NOCASE').get(folderPath) as
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
  const rows = stmt(`SELECT ${PHOTO_LITE_COLS} FROM photos WHERE folder_id = ?`).all(
    folderId
  ) as PhotoLite[]
  const run = db.transaction(() => {
    stmt(
      `DELETE FROM photo_tags WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`
    ).run(folderId)
    stmt(
      `DELETE FROM album_photos WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`
    ).run(folderId)
    stmt('DELETE FROM photos WHERE folder_id = ?').run(folderId)
    stmt('DELETE FROM folders WHERE id = ?').run(folderId)
  })
  run()
  markPhashDirty()
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

/** 批量获取照片行（不存在的 id 不在返回值中） */
export function getPhotoRows(ids: number[]): { id: number; path: string }[] {
  if (!ids.length) return []
  const rows: { id: number; path: string }[] = []
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900)
    const ph = chunk.map(() => '?').join(', ')
    const part = stmt(`SELECT id, path FROM photos WHERE id IN (${ph})`).all(...chunk) as {
      id: number
      path: string
    }[]
    rows.push(...part)
  }
  return rows
}

export function findPhotoByPath(photoPath: string): PhotoLite | undefined {
  // 路径匹配大小写不敏感（Windows FS 语义），走 idx_photos_path_ci
  return stmt(`SELECT ${PHOTO_LITE_COLS} FROM photos WHERE path = ? COLLATE NOCASE`).get(
    photoPath
  ) as PhotoLite | undefined
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

/** 批量插入（单事务），返回实际新插入的照片 id 列表；
 *  与监听写入并发时同路径冲突（含大小写变体）按幂等忽略处理，不拖垮整批 */
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
  const run = db.transaction((): number[] => {
    const ids: number[] = []
    const ins = stmt(
      `INSERT OR IGNORE INTO photos (folder_id, path, name, ext, size, mtime, imported_at)
       VALUES (@folder_id, @path, @name, @ext, @size, @mtime, @imported_at)`
    )
    for (const r of rows) {
      const info = ins.run(r)
      if (info.changes > 0) ids.push(Number(info.lastInsertRowid))
    }
    return ids
  })
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
          WHERE pt.photo_id = photos.id), '') || ' ' ||
  IFNULL((SELECT group_concat(a.name, ' ') FROM album_photos ap JOIN albums a ON a.id = ap.album_id
          WHERE ap.photo_id = photos.id), '')`

/** 重算照片的搜索文本（名称+标题+描述+标签名+相册名），FTS 触发器随之同步索引 */
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
): void {  const sets: string[] = []
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
  // 缺失状态影响重复簇成员，需使聚类缓存失效
  if (fields.missing !== undefined) markPhashDirty()
}

/** 批量重命名后更新索引中的路径与文件名，并重算搜索文本 */
export function updatePhotoPath(id: number, newPath: string, newName: string): void {
  let mtime: number | null = null
  try {
    mtime = Math.round(fs.statSync(newPath).mtimeMs)
  } catch {
    /* rename 后 stat 失败保持旧值 */
  }
  if (mtime !== null) {
    stmt('UPDATE photos SET path = ?, name = ?, mtime = ? WHERE id = ?').run(newPath, newName, mtime, id)
  } else {
    stmt('UPDATE photos SET path = ?, name = ? WHERE id = ?').run(newPath, newName, id)
  }
  recomputeSearchText([id])
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
  if (!ids.length) return
  const run = db.transaction(() => {
    // 按 900 个一批拆分 IN 子句，避免超过 SQLite 变量上限
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900)
      const ph = chunk.map(() => '?').join(', ')
      stmt(`DELETE FROM photo_tags WHERE photo_id IN (${ph})`).run(...chunk)
      stmt(`DELETE FROM album_photos WHERE photo_id IN (${ph})`).run(...chunk)
      stmt(`DELETE FROM photos WHERE id IN (${ph})`).run(...chunk)
    }
  })
  run()
  markPhashDirty()
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
  // 软删除过滤：回收站视图只看已删行，其余所有作用域一律排除已删行
  if (q.scope === 'trash') {
    where.push('p.deleted_at IS NOT NULL')
  } else {
    where.push('p.deleted_at IS NULL')
  }
  if (q.keyword && q.keyword.trim()) {
    const kw = q.keyword.trim()
    if (kw.length >= 3) {
      // trigram 分词支持任意 ≥3 字子串匹配（含中文）；短语包裹防 MATCH 语法注入
      where.push('p.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH @fts)')
      params.fts = `"${kw.replace(/"/g, '""')}"`
    } else {
      // 短词走 LIKE：直接对冗余列匹配（与 FTS 同一文本源，覆盖名称/标题/描述/标签/相册）
      where.push('p.search_text LIKE @kw')
      params.kw = `%${kw}%`
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
  // 回收站按删除时间倒序（最新删除在前），不做时间线分组
  if (q.scope === 'trash') return 'ORDER BY p.deleted_at DESC, p.id DESC'
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
      // 拍摄/导入时间排序走 v10 物化列 sort_ts（索引供序，免全量重排）
      return `ORDER BY p.sort_ts ${dir}, p.id ${dir}`
  }
}

export function queryPhotos(q: PhotoQuery): QueryResult {
  const { whereSql, params } = buildPhotoFilter(resolveSmartFilters(q))
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
  const { whereSql, params } = buildPhotoFilter(resolveSmartFilters(q))
  const rows = stmt(`SELECT p.id FROM photos p ${whereSql} LIMIT 200000`).all(params) as {
    id: number
  }[]
  return rows.map((r) => r.id)
}

/** 智能相册 scope：以保存的筛选条件覆盖查询条件 */
function resolveSmartFilters(q: PhotoQuery): PhotoQuery {
  if (q.scope === 'smart' && q.scopeId) {
    const saved = getSmartAlbumQuery(q.scopeId)
    if (saved) {
      return { ...q, keyword: saved.keyword, dateFrom: saved.dateFrom, dateTo: saved.dateTo, minRating: saved.minRating }
    }
  }
  return q
}

/* ---------- smart albums ---------- */

export function listSmartAlbums(): SmartAlbumInfo[] {
  return stmt('SELECT id, name, color, created_at FROM smart_albums ORDER BY created_at ASC').all() as SmartAlbumInfo[]
}

export function getSmartAlbumQuery(id: number): SmartAlbumQuery | undefined {
  const row = stmt('SELECT query FROM smart_albums WHERE id = ?').get(id) as
    | { query: string }
    | undefined
  if (!row) return undefined
  try {
    const q = JSON.parse(row.query) as SmartAlbumQuery
    return typeof q === 'object' && q !== null ? q : undefined
  } catch {
    return undefined
  }
}

export function createSmartAlbum(name: string, query: SmartAlbumQuery): number {
  const info = stmt(
    'INSERT INTO smart_albums (name, color, query, created_at) VALUES (?, NULL, ?, ?)'
  ).run(name, JSON.stringify(query), Date.now())
  return Number(info.lastInsertRowid)
}

export function renameSmartAlbum(id: number, name: string): void {
  stmt('UPDATE smart_albums SET name = ? WHERE id = ?').run(name, id)
}

export function deleteSmartAlbum(id: number): void {
  stmt('DELETE FROM smart_albums WHERE id = ?').run(id)
}

/* ---------- tags ---------- */

export function listTags(): TagInfo[] {
  return stmt(
    `SELECT t.id, t.name, t.color,
      (SELECT COUNT(*) FROM photo_tags pt JOIN photos p ON p.id = pt.photo_id
        WHERE pt.tag_id = t.id AND p.missing = 0 AND p.deleted_at IS NULL) AS count
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

export function setTagColor(id: number, color: string | null): void {
  stmt('UPDATE tags SET color = ? WHERE id = ?').run(color, id)
}

export function setAlbumColor(id: number, color: string | null): void {
  stmt('UPDATE albums SET color = ? WHERE id = ?').run(color, id)
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
      (SELECT COUNT(*) FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
        WHERE ap.album_id = a.id AND p.missing = 0 AND p.deleted_at IS NULL) AS count,
      (SELECT ap.photo_id FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
        WHERE ap.album_id = a.id AND p.missing = 0 AND p.deleted_at IS NULL LIMIT 1) AS cover_id
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

/* ---------- 回收站（软删除） ---------- */

/** 软删除：索引移入回收站视图，磁盘文件保留在原位置；返回实际更新的行数 */
export function softDeletePhotos(ids: number[]): number {
  if (!ids.length) return 0
  const now = Date.now()
  let n = 0
  const run = db.transaction(() => {
    const up = stmt('UPDATE photos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    for (const id of ids) {
      n += up.run(now, id).changes
    }
  })
  run()
  // 已删行不再参与相似聚类
  markPhashDirty()
  return n
}

/** 还原：清除 deleted_at，照片立即回到原作用域 */
export function restorePhotos(ids: number[]): number {
  if (!ids.length) return 0
  let n = 0
  const run = db.transaction(() => {
    const up = stmt('UPDATE photos SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    for (const id of ids) {
      n += up.run(id).changes
    }
  })
  run()
  markPhashDirty()
  return n
}

/** 按路径查找已在回收站中的照片（watcher 检测到文件重新出现时自动还原用） */
export function findDeletedPhotoId(photoPath: string): number | null {
  const row = stmt('SELECT id FROM photos WHERE path = ? COLLATE NOCASE AND deleted_at IS NOT NULL').get(
    photoPath
  ) as { id: number } | undefined
  return row?.id ?? null
}

/** 指定 id 中已在回收站内的行（彻底删除前的安全过滤） */
export function listDeletedRows(ids: number[]): { id: number; path: string }[] {
  if (!ids.length) return []
  const rows: { id: number; path: string }[] = []
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900)
    const ph = chunk.map(() => '?').join(', ')
    const part = stmt(
      `SELECT id, path FROM photos WHERE deleted_at IS NOT NULL AND id IN (${ph})`
    ).all(...chunk) as { id: number; path: string }[]
    rows.push(...part)
  }
  return rows
}

/** 回收站全部行（清空回收站用） */
export function listAllDeletedRows(): { id: number; path: string }[] {
  return stmt('SELECT id, path FROM photos WHERE deleted_at IS NOT NULL').all() as {
    id: number
    path: string
  }[]
}

/* ---------- stats ---------- */

export function listPhotoIdsForRebuild(): number[] {
  const rows = stmt('SELECT id FROM photos WHERE missing = 0 AND deleted_at IS NULL')
    .all() as { id: number }[]
  return rows.map((r) => r.id)
}

/** 上次退出时未完成缩略图生成的照片（用于启动续跑） */
export function listPhotoIdsPendingThumb(): number[] {
  const rows = stmt('SELECT id FROM photos WHERE thumb_status = 0 AND missing = 0 AND deleted_at IS NULL')
    .all() as { id: number }[]
  return rows.map((r) => r.id)
}

/** 全量照片 id（孤儿缩略图清理用；含回收站照片——还原时缩略图需即时可用） */
export function listAllPhotoIds(): number[] {
  const rows = stmt('SELECT id FROM photos').all() as { id: number }[]
  return rows.map((r) => r.id)
}

/* ---------- 感知哈希（相似照片检测） ---------- */

export function setPhotoPhash(id: number, lo: number, hi: number): void {
  stmt('UPDATE photos SET phash_lo = ?, phash_hi = ? WHERE id = ?').run(lo, hi, id)
}

export function listPhotosForPhash(): { id: number; path: string }[] {
  return stmt(
    'SELECT id, path FROM photos WHERE phash_lo IS NULL AND missing = 0 AND deleted_at IS NULL'
  ).all() as {
    id: number
    path: string
  }[]
}

export function listPhashes(): { id: number; lo: number; hi: number }[] {
  return stmt(
    'SELECT id, phash_lo AS lo, phash_hi AS hi FROM photos WHERE phash_lo IS NOT NULL AND missing = 0 AND deleted_at IS NULL'
  ).all() as { id: number; lo: number; hi: number }[]
}

/** 聚类结果缓存（保留簇边界）：哈希/缺失/删除变化后置脏，下次查询在 worker 中重算 */
let dupClustersCache: number[][] | null = null
/** 置脏代次：计算期间再次置脏时，本次结果作废不缓存，下次查询重算 */
let dupGen = 0
let dupInflight: { gen: number; promise: Promise<number[][]> } | null = null

export function markPhashDirty(): void {
  dupGen++
  dupClustersCache = null
}

/**
 * 疑似重复簇（仅含成员数 ≥ 2 的簇）。
 * 聚类在 worker 线程执行，不阻塞主进程；并发调用合并为同一次计算。
 */
export async function duplicateClusters(): Promise<number[][]> {
  if (dupClustersCache) return dupClustersCache
  if (dupInflight && dupInflight.gen === dupGen) return dupInflight.promise
  const myGen = dupGen
  const promise = (async (): Promise<number[][]> => {
    const rows = listPhashes().sort((a, b) => a.id - b.id)
    return (await computePhashClusters(rows)).filter((c) => c.length >= 2)
  })()
  dupInflight = { gen: myGen, promise }
  let result: number[][]
  try {
    result = await promise
  } finally {
    if (dupInflight?.promise === promise) dupInflight = null
  }
  // 计算期间哈希/缺失状态变化：本次结果可能略旧，直接返回但不缓存
  if (myGen !== dupGen) return result
  dupClustersCache = result
  return result
}

/** 疑似重复照片 id（按簇顺序排列） */
export async function duplicatePhotoIds(): Promise<number[]> {
  return (await duplicateClusters()).flat()
}

/** 按簇顺序查询疑似重复照片（支持分页） */
export async function queryDuplicates(q: { limit?: number; offset?: number }): Promise<QueryResult> {
  const ids = await duplicatePhotoIds()
  const limit = Math.min(q.limit ?? 50000, 100000)
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  const slice = ids.slice(offset, offset + limit)
  if (!slice.length) return { items: [], total: ids.length }
  const ph = slice.map(() => '?').join(', ')
  const caseWhen = slice.map((id, i) => `WHEN ${id} THEN ${i}`).join(' ')
  const items = stmt(
    `SELECT ${PHOTO_LITE_COLS} FROM photos p WHERE p.id IN (${ph}) ORDER BY CASE p.id ${caseWhen} END`
  ).all(...slice) as PhotoLite[]
  return { items, total: ids.length }
}

export function libraryStats(): { total: number; missing: number; untagged: number; trash: number } {
  const total = (
    stmt('SELECT COUNT(*) AS c FROM photos WHERE missing = 0 AND deleted_at IS NULL').get() as {
      c: number
    }
  ).c
  const missing = (
    stmt('SELECT COUNT(*) AS c FROM photos WHERE missing = 1 AND deleted_at IS NULL').get() as {
      c: number
    }
  ).c
  const untagged = (
    stmt(
      'SELECT COUNT(*) AS c FROM photos p WHERE p.missing = 0 AND p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)'
    ).get() as { c: number }
  ).c
  const trash = (
    stmt('SELECT COUNT(*) AS c FROM photos WHERE deleted_at IS NOT NULL').get() as { c: number }
  ).c
  return { total, missing, untagged, trash }
}
