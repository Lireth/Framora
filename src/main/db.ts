import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { app, dialog } from 'electron'
import { computePhashClusters } from './phashCluster'
import { logError } from './log'
import type {
  AlbumInfo,
  LibraryDistribution,
  FolderInfo,
  PhotoLite,
  PhotoQuery,
  PhotoRecord,
  QueryResult,
  SmartAlbumInfo,
  SmartAlbumQuery,
  TagInfo,
  TagRef,
} from '@shared/types'

let db: Database.Database

/**
 * 预编译语句缓存：better-sqlite3 不缓存 prepare 结果，热路径重复编译有额外开销。
 * 动态拼接的 SQL（IN 列表长度、LIMIT 组合）会产生无上界的新条目（OPT-30）——
 * 超限时按插入序淘汰最旧条目（近似 LRU：热点语句命中即被 Map 重插到末尾）。
 */
const stmtCache = new Map<string, Database.Statement>()
const STMT_CACHE_MAX = 256

function stmt(sql: string): Database.Statement {
  let s = stmtCache.get(sql)
  if (s) {
    // 重插到 Map 末尾实现近似 LRU
    stmtCache.delete(sql)
    stmtCache.set(sql, s)
    return s
  }
  s = db.prepare(sql)
  if (stmtCache.size >= STMT_CACHE_MAX) {
    const oldest = stmtCache.keys().next().value
    if (oldest !== undefined) stmtCache.delete(oldest)
  }
  stmtCache.set(sql, s)
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
  columnDef: string,
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
  //     注意：此处必须使用 v8 时代的表达式（无 deleted_at 过滤）——全新库执行到 v8 时
  //     v11 的 deleted_at 列尚未创建，直接引用会导致 CREATE TRIGGER 失败。
  (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS album_photos_search_insert;
      DROP TRIGGER IF EXISTS album_photos_search_delete;
      DROP TRIGGER IF EXISTS albums_search_rename;
      CREATE TRIGGER album_photos_search_insert AFTER INSERT ON album_photos BEGIN
        UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR_V8} WHERE id = new.photo_id;
      END;
      CREATE TRIGGER album_photos_search_delete AFTER DELETE ON album_photos BEGIN
        UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR_V8} WHERE id = old.photo_id;
      END;
      CREATE TRIGGER albums_search_rename AFTER UPDATE OF name ON albums BEGIN
        UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR_V8}
          WHERE id IN (SELECT photo_id FROM album_photos WHERE album_id = new.id);
      END;
    `)
    db.exec(`UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR_V8};`)
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
      'INTEGER GENERATED ALWAYS AS (COALESCE(taken_at, imported_at)) VIRTUAL',
    )
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_photos_sort_ts ON photos(sort_ts);
      CREATE INDEX IF NOT EXISTS idx_photos_size ON photos(size);
    `)
  },
  // v11: 元数据软删除 —— 文件夹 / 标签 / 相册增加 deleted_at，使移除操作可撤销。
  //      关联表（photo_tags / album_photos）保持不变，恢复时无需重建关系；
  //      所有读取路径（列表/计数/检索文本/重复聚类）统一排除已删行。
  //      同时用带 deleted_at 过滤的表达式重建搜索触发器（历史触发器内嵌的是旧表达式）。
  (db) => {
    addColumnIfMissing(db, 'folders', 'deleted_at', 'INTEGER')
    addColumnIfMissing(db, 'tags', 'deleted_at', 'INTEGER')
    addColumnIfMissing(db, 'albums', 'deleted_at', 'INTEGER')
    db.exec(`
      DROP TRIGGER IF EXISTS photos_search_insert;
      CREATE TRIGGER photos_search_insert AFTER INSERT ON photos BEGIN
        UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR} WHERE id = new.id;
      END;

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
  },
  // v12: 搜索文本维护改为应用层脏队列 —— 移除相册成员变更/重命名的同步触发器。
  //      批量写入不再逐行执行两条相关子查询 + FTS 重写，而是在事务提交后统一入队，
  //      由后台按批重算；关键词检索前会先冲刷队列，读到的始终是最新文本。
  (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS album_photos_search_insert;
      DROP TRIGGER IF EXISTS album_photos_search_delete;
      DROP TRIGGER IF EXISTS albums_search_rename;
    `)
  },
  // v13: 插入路径搜索文本并入脏队列 + 常规视图部分复合索引（十万级演进）。
  //      ① photos_search_insert 触发器逐行执行两条相关子查询并联动 FTS 重写，万级
  //        导入即万次逐行计算——移除后新插入行走 recomputeSearchText 脏队列（与 v12
  //        同款机制）；FTS 入库触发器对空文本天然跳过（v3 语义），重算 UPDATE 时
  //        photos_fts_update 自动同步索引，无需回填存量（旧触发器已保证其完整）。
  //      ② 常规视图 WHERE=可见文件夹 + 未删除、ORDER BY=单列的组合查询此前只能
  //        多索引拼合；部分复合索引（WHERE deleted_at IS NULL，回收站零成本）让
  //        「文件夹内按时间倒序」等查询在十万级仍由索引直接供序。
  (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS photos_search_insert;
      CREATE INDEX IF NOT EXISTS idx_photos_view_sort_ts ON photos(sort_ts, id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_photos_folder_sort_ts ON photos(folder_id, sort_ts) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_photos_view_imported ON photos(imported_at, id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_photos_view_name ON photos(name COLLATE NOCASE, id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_photos_view_rating ON photos(rating, id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_photos_view_size ON photos(size, id) WHERE deleted_at IS NULL;
    `)
  },
  // v14: 智能相册软删除（FEAT-13）——与文件夹/标签/相册对齐，删除可撤销
  (db) => {
    addColumnIfMissing(db, 'smart_albums', 'deleted_at', 'INTEGER')
  },
  // v15: 检索文本纳入所属文件夹名（FEAT-15）——按文件夹名检索其内容；
  //      存量库全量重算 + FTS 重建（新增行由脏队列按新表达式维护）
  (db) => {
    db.exec(`UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR};`)
    db.exec(`INSERT INTO photos_fts(photos_fts) VALUES ('rebuild');`)
  },
  // v16: 地点与统计（FEAT-07/08）——GPS 坐标与相机型号入库；
  //      gps_checked 标记「已尝试解析」（无 GPS 的照片标记后不再重复入队）
  (db) => {
    addColumnIfMissing(db, 'photos', 'gps_lat', 'REAL')
    addColumnIfMissing(db, 'photos', 'gps_lon', 'REAL')
    addColumnIfMissing(db, 'photos', 'gps_checked', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(db, 'photos', 'camera', 'TEXT')
  },
  // v17: 相似检测增强（FEAT-17）——翻转哈希（镜像副本匹配）与颜色均值
  //      （纯色/低梯度误判校验）；phash_x_checked 标记增强数据已补算
  (db) => {
    addColumnIfMissing(db, 'photos', 'phash_flip_lo', 'INTEGER')
    addColumnIfMissing(db, 'photos', 'phash_flip_hi', 'INTEGER')
    addColumnIfMissing(db, 'photos', 'color_mean', 'INTEGER')
    addColumnIfMissing(db, 'photos', 'phash_x_checked', 'INTEGER NOT NULL DEFAULT 0')
  },
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

/* ---------- 备份导入：校验、原子替换与中断恢复 ---------- */

/** 备份必须包含的核心表（v1 基线）；后续版本新增的表允许缺失，由迁移补齐 */
const CORE_TABLES = [
  'folders',
  'photos',
  'tags',
  'photo_tags',
  'albums',
  'album_photos',
  'settings',
] as const

interface BackupProbe {
  version: number
  size: number
}

/** 备份校验失败（区别于底层 SQLite 异常，用于保留可读中文提示） */
class BackupError extends Error {}

/**
 * 只读探测备份：核心表、schema 版本上界、integrity_check。
 * 任何一项失败都在关闭当前索引库之前抛出，调用方仍可继续使用原库。
 */
function probeBackupFile(file: string): BackupProbe {
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    throw new BackupError('备份文件不存在或不可访问')
  }
  if (!st.isFile()) throw new BackupError('所选路径不是文件')
  if (st.size <= 0) throw new BackupError('备份文件为空')
  // 未合并的 WAL 意味着备份可能缺少最近写入；官方导出为单文件，不包含 -wal
  try {
    const wal = fs.statSync(`${file}-wal`)
    if (wal.size > 0) {
      throw new BackupError(
        '检测到未合并的 WAL 文件，该文件可能不是完整备份。请正常退出应用后重新导出索引库备份。'
      )
    }
  } catch (err) {
    if (err instanceof BackupError) throw err
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new BackupError(`无法检查备份的 WAL 状态：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let probe: Database.Database
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true })
  } catch (err) {
    throw new BackupError(
      `无法打开备份文件：${err instanceof Error ? err.message : String(err)}`
    )
  }
  try {
    const version = probe.pragma('user_version', { simple: true }) as number
    if (!Number.isInteger(version) || version < 0) {
      throw new BackupError('备份的 schema 版本无效')
    }
    if (version > MIGRATIONS.length) {
      throw new BackupError(
        `备份由更新版本的拾帧创建（schema v${version}），当前应用最高支持 v${MIGRATIONS.length}。请先升级应用后再导入。`
      )
    }
    const tables = new Set(
      (
        probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string
        }[]
      ).map((r) => r.name)
    )
    const missing = CORE_TABLES.filter((t) => !tables.has(t))
    if (missing.length) {
      throw new BackupError(`备份缺少必要数据表：${missing.join('、')}`)
    }
    const rows = probe.pragma('integrity_check') as Record<string, unknown>[]
    const messages = rows.map((r) => String(r['integrity_check'] ?? Object.values(r)[0] ?? ''))
    if (messages.length !== 1 || messages[0] !== 'ok') {
      throw new BackupError(
        `备份完整性校验失败：${messages.slice(0, 3).join('；') || '未知错误'}`
      )
    }
    return { version, size: st.size }
  } catch (err) {
    if (err instanceof BackupError) throw err
    throw new BackupError(
      `无法读取备份文件（可能已损坏）：${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    probe.close()
  }
}

/** 落盘后 fsync，确保 rename 之前数据已写入磁盘（不支持的后端放行） */
async function fsyncFile(file: string): Promise<void> {
  const fh = await fs.promises.open(file, 'r+')
  try {
    await fh.sync()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw err
  } finally {
    await fh.close()
  }
}

function latestFile(names: string[], prefix: string): string | null {
  const hits = names
    .filter((n) => n.startsWith(prefix) && !n.endsWith('-wal') && !n.endsWith('-shm'))
    .sort()
  return hits.length ? hits[hits.length - 1] : null
}

/**
 * 启动时恢复被中断的备份导入：
 * - 目标库缺失且存在完整临时副本（校验后已 fsync）→ 提升为正式库；
 * - 否则回退到最近一次 .pre-import 原库；
 * - 目标库存在时清掉残留临时文件。
 */
function recoverInterruptedImport(): void {
  const dir = app.getPath('userData')
  const target = path.join(dir, 'framora.db')
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const temps = names.filter((n) => n.startsWith('framora.db.importing-'))
  const removeTargetSidecars = (): void => {
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${target}${suffix}`, { force: true })
      } catch {
        /* 单个边车文件清理失败忽略 */
      }
    }
  }
  const removeTemps = (): void => {
    for (const n of temps) {
      try {
        fs.rmSync(path.join(dir, n), { force: true })
      } catch {
        /* 单个临时文件清理失败忽略 */
      }
    }
  }

  if (!fs.existsSync(target)) {
    const temp = latestFile(names, 'framora.db.importing-')
    if (temp) {
      try {
        // 临时副本是单文件、已 checkpoint；清除可能残留的旧边车，避免被套用到新库
        removeTargetSidecars()
        fs.renameSync(path.join(dir, temp), target)
        removeTemps()
        return
      } catch {
        /* 提升失败：继续尝试原库回退 */
      }
    }
    const pre = latestFile(names, 'framora.db.pre-import-')
    if (pre) {
      try {
        for (const suffix of ['-wal', '-shm']) {
          const sib = path.join(dir, `${pre}${suffix}`)
          if (!fs.existsSync(sib)) continue
          try {
            fs.rmSync(`${target}${suffix}`, { force: true })
          } catch {
            /* ignore */
          }
          fs.renameSync(sib, `${target}${suffix}`)
        }
        fs.renameSync(path.join(dir, pre), target)
        removeTemps()
        return
      } catch {
        /* 回退失败：交给 initDb 的常规重建路径 */
      }
    }
  }
  removeTemps()
}

export async function initDb(): Promise<void> {
  const userData = app.getPath('userData')
  fs.mkdirSync(path.join(userData, 'thumbs'), { recursive: true })
  fs.mkdirSync(path.join(userData, 'backups'), { recursive: true })
  recoverInterruptedImport()
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
      detail: `照片文件不受影响，请重新导入文件夹恢复索引。\n\n错误信息：${err instanceof Error ? err.message : String(err)}`,
    })
    await openAndMigrate()
  }
}

async function openAndMigrate(): Promise<void> {
  // 换库/重开后旧库的脏 id 不再适用
  discardSearchTextQueue()
  db = new Database(path.join(app.getPath('userData'), 'framora.db'))
  stmtCache.clear()
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  // 收紧 WAL 自动合并阈值（默认 1000 页）：大批量导入的长事务期间 WAL 持续增长，
  // 降低阈值让合并更频繁发生，控制 WAL 文件体积与后续备份/换库的合并成本
  db.pragma('wal_autocheckpoint = 400')
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
  // 退出前尽力把搜索文本落库，避免下次启动检索缺标签/相册名
  try {
    flushSearchText()
  } catch (err) {
    logError('searchText', err)
  }
  discardSearchTextQueue()
  // 关库前把 WAL 全量合并回主库并截断：缩小库文件足迹，换库/迁移备份的
  // 「未合并 WAL」探测成本也随之归零
  try {
    db?.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* ignore */
  }
  try {
    db?.close()
  } catch {
    /* ignore */
  }
}

/** 导出当前索引库为单文件备份（better-sqlite3 backup API，对 WAL 安全） */
export async function exportBackup(destFile: string): Promise<void> {
  // 备份必须包含最新检索文本：先同步冲刷脏队列
  flushSearchText()
  // 导出前全量合并 WAL：单文件备份即为完整最新状态
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* 合并失败不阻断导出（backup API 本身对 WAL 安全） */
  }
  await db.backup(destFile)
}

/** 恢复被移动的原库并重开；无论成功与否都以异常结束（调用方处于失败分支） */
async function restoreMovedDb(
  moved: { src: string; dest: string }[],
  cause: unknown
): Promise<never> {
  for (const f of [...moved].reverse()) {
    try {
      fs.renameSync(f.dest, f.src)
    } catch {
      /* 单个文件恢复失败：继续尝试其余文件与重开 */
    }
  }
  try {
    await openAndMigrate()
  } catch (reopenErr) {
    throw new Error(
      `导入失败，且恢复原索引库时出错：${cause instanceof Error ? cause.message : String(cause)}；${reopenErr instanceof Error ? reopenErr.message : String(reopenErr)}`,
      { cause: reopenErr }
    )
  }
  throw new Error(
    `导入失败，已恢复原索引库：${cause instanceof Error ? cause.message : String(cause)}`
  )
}

/**
 * 用备份文件替换当前索引库：
 * 只读校验（核心表 / 版本上界 / integrity_check）→ 同卷临时副本 + fsync →
 * 关闭原库 → 原库改名为 .pre-import → 临时副本 rename 为正式库 → 重开并迁移。
 * 任一步失败都会回滚并重开原库；照片文件本体不受影响。
 */
export async function importBackup(srcFile: string): Promise<void> {
  const target = path.join(app.getPath('userData'), 'framora.db')
  if (path.resolve(srcFile).toLowerCase() === path.resolve(target).toLowerCase()) {
    throw new Error('不能导入当前正在使用的索引库，请先使用“导出索引库备份”生成备份文件。')
  }
  // 校验在关闭当前库之前完成：失败时应用继续使用原库
  const probe = probeBackupFile(srcFile)
  const stamp = Date.now()
  const temp = `${target}.importing-${stamp}`

  try {
    await fs.promises.copyFile(srcFile, temp)
    const copied = await fs.promises.stat(temp)
    if (copied.size !== probe.size) throw new Error('备份复制不完整，已取消导入')
    await fsyncFile(temp)
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }

  closeDb()
  const moved: { src: string; dest: string }[] = []
  try {
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const src = `${target}${suffix}`
        if (!fs.existsSync(src)) continue
        const dest = `${target}.pre-import-${stamp}${suffix}`
        fs.renameSync(src, dest)
        moved.push({ src, dest })
      }
      // 同卷 rename 原子生效：任何时刻正式库要么是旧文件，要么是完整新文件
      fs.renameSync(temp, target)
    } catch (err) {
      await restoreMovedDb(moved, err)
    }

    try {
      await openAndMigrate()
      markPhashDirty()
    } catch (err) {
      closeDb()
      // 清除可能半开的新库（含 WAL/SHM）后恢复旧库
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(`${target}${suffix}`, { force: true })
        } catch {
          /* 单个文件删除失败：继续尝试回滚 */
        }
      }
      await restoreMovedDb(moved, err)
    }
  } finally {
    try {
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true })
    } catch {
      /* 临时文件清理失败不影响结果 */
    }
  }
}

/* ---------- settings ---------- */

export function getSetting(key: string): string | null {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  stmt(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

/* ---------- folders ---------- */

export function listFolders(): FolderInfo[] {
  return stmt(
    `SELECT f.id, f.path, f.name, f.added_at,
      (SELECT COUNT(*) FROM photos p WHERE p.folder_id = f.id AND p.missing = 0 AND p.deleted_at IS NULL) AS count
     FROM folders f WHERE f.deleted_at IS NULL ORDER BY f.added_at ASC`,
  ).all() as FolderInfo[]
}

/** 按路径取文件夹（含已软删除行：导入同一路径时据此复活，而不是新建重复根） */
export function getFolderByPath(
  folderPath: string,
): (FolderInfo & { deleted_at: number | null }) | undefined {
  // 路径匹配大小写不敏感（Windows FS 语义），走 idx_folders_path_ci
  return stmt('SELECT * FROM folders WHERE path = ? COLLATE NOCASE').get(folderPath) as
    (FolderInfo & { deleted_at: number | null }) | undefined
}

/** 已注册资料库文件夹路径（media 协议读取范围校验用；已移除的文件夹不再授权读取） */
export function listFolderPaths(): string[] {
  const rows = stmt('SELECT path FROM folders WHERE deleted_at IS NULL').all() as { path: string }[]
  return rows.map((r) => r.path)
}

export function addFolder(folderPath: string, name: string): number {
  const info = stmt('INSERT OR IGNORE INTO folders (path, name, added_at) VALUES (?, ?, ?)').run(
    folderPath,
    name,
    Date.now(),
  )
  if (info.changes > 0) return Number(info.lastInsertRowid)
  return getFolderByPath(folderPath)!.id
}

/**
 * 从资料库移除文件夹（软删除）：仅隐藏索引，照片行与标签/相册关系全部保留，
 * 磁盘文件与缩略图均不动，恢复时清除 deleted_at 即可 O(1) 复原。
 */
export function softRemoveFolder(folderId: number): { name: string; photos: number } | null {
  const row = stmt('SELECT name FROM folders WHERE id = ? AND deleted_at IS NULL').get(folderId) as
    { name: string } | undefined
  if (!row) return null
  const photos = (
    stmt(
      'SELECT COUNT(*) AS c FROM photos WHERE folder_id = ? AND missing = 0 AND deleted_at IS NULL',
    ).get(folderId) as { c: number }
  ).c
  stmt('UPDATE folders SET deleted_at = ? WHERE id = ?').run(Date.now(), folderId)
  markPhashDirty()
  return { name: row.name, photos }
}

/** 撤销移除文件夹：清除 deleted_at；调用方按返回路径决定是否重挂文件监听 */
export function restoreFolder(folderId: number): { path: string; name: string } | null {
  const row = stmt('SELECT path, name FROM folders WHERE id = ? AND deleted_at IS NOT NULL').get(
    folderId,
  ) as { path: string; name: string } | undefined
  if (!row) return null
  stmt('UPDATE folders SET deleted_at = NULL WHERE id = ?').run(folderId)
  markPhashDirty()
  return row
}

/* ---------- photos ---------- */

const PHOTO_LITE_COLS = `id, path, name, ext, size, folder_id, rating, width, height, taken_at,
  imported_at, thumb_status, thumb_ts, missing, orientation`

export function getPhotoRow(
  id: number,
):
  | (PhotoLite & {
      title: string | null
      description: string | null
      flip_h: number
      flip_v: number
      mtime: number
    })
  | undefined {
  return stmt(
    `SELECT ${PHOTO_LITE_COLS}, title, description, flip_h, flip_v, mtime FROM photos WHERE id = ?`,
  ).get(id) as never
}

export function findPhotoByPath(photoPath: string): PhotoLite | undefined {
  // 路径匹配大小写不敏感（Windows FS 语义），走 idx_photos_path_ci
  return stmt(`SELECT ${PHOTO_LITE_COLS} FROM photos WHERE path = ? COLLATE NOCASE`).get(
    photoPath,
  ) as PhotoLite | undefined
}

export function listPhotoRowsByFolder(
  folderId: number,
): { id: number; path: string; mtime: number; size: number; missing: number }[] {
  return stmt('SELECT id, path, mtime, size, missing FROM photos WHERE folder_id = ?').all(
    folderId,
  ) as never
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
     VALUES (@folder_id, @path, @name, @ext, @size, @mtime, @imported_at)`,
  ).run(p)
  const id = Number(info.lastInsertRowid)
  // v13 起插入不再触发逐行重算：搜索文本并入脏队列（单张 ≤64 行同步冲刷，检索即时一致）
  recomputeSearchText([id])
  return id
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
  }[],
): number[] {
  const run = db.transaction((): number[] => {
    const ids: number[] = []
    const ins = stmt(
      `INSERT OR IGNORE INTO photos (folder_id, path, name, ext, size, mtime, imported_at)
       VALUES (@folder_id, @path, @name, @ext, @size, @mtime, @imported_at)`,
    )
    for (const r of rows) {
      const info = ins.run(r)
      if (info.changes > 0) ids.push(Number(info.lastInsertRowid))
    }
    return ids
  })
  const ids = run()
  // v13 起插入不再触发逐行重算：提交后统一入队后台重算（检索前 flushSearchTextForRead 兜底）
  recomputeSearchText(ids)
  return ids
}

/** 批量更新文件字段（size/mtime/missing），单事务 */
export function updatePhotoFilesBatch(
  rows: { id: number; size?: number; mtime?: number; missing?: 0 | 1 }[],
): void {
  const run = db.transaction(() => {
    for (const r of rows) updatePhotoFileFields(r.id, r)
  })
  run()
}

/** 按 900 个一批拆分 IN 子句（SQLite 变量上限），run 返回各批结果的拼接（OPT-35 去重） */
function chunkedIn<T>(ids: number[], run: (chunk: number[], ph: string) => T[]): T[] {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900)
    out.push(...run(chunk, chunk.map(() => '?').join(', ')))
  }
  return out
}

/** 可见文件夹条件：已从资料库移除（软删除）的文件夹，其照片不参与任何常规视图/统计 */
const VISIBLE_FOLDER_SQL = `p.folder_id IN (SELECT id FROM folders WHERE deleted_at IS NULL)`

/** v8 迁移期的检索表达式（不含 deleted_at 过滤）：历史迁移不得引用后续迁移才有的列 */
const SEARCH_TEXT_EXPR_V8 = `
  name || ' ' || IFNULL(title, '') || ' ' || IFNULL(description, '') || ' ' ||
  IFNULL((SELECT group_concat(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.photo_id = photos.id), '') || ' ' ||
  IFNULL((SELECT group_concat(a.name, ' ') FROM album_photos ap JOIN albums a ON a.id = ap.album_id
          WHERE ap.photo_id = photos.id), '')`

/** 运行期检索文本表达式（v15 起含所属文件夹名；文件夹名导入后不可改，无需联动触发器） */
const SEARCH_TEXT_EXPR = `
  name || ' ' || IFNULL(title, '') || ' ' || IFNULL(description, '') || ' ' ||
  IFNULL((SELECT group_concat(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.photo_id = photos.id AND t.deleted_at IS NULL), '') || ' ' ||
  IFNULL((SELECT group_concat(a.name, ' ') FROM album_photos ap JOIN albums a ON a.id = ap.album_id
          WHERE ap.photo_id = photos.id AND a.deleted_at IS NULL), '') || ' ' ||
  IFNULL((SELECT f.name FROM folders f WHERE f.id = photos.folder_id AND f.deleted_at IS NULL), '')`

/* ---------- 搜索文本脏队列 ---------- */

/** 单批重算行数：一条 UPDATE 走 json_each 参数，不受 SQLite 变量上限约束 */
const SEARCH_TEXT_BATCH = 500
/** 不超过该规模时同步完成，保证单张照片编辑后检索立即一致 */
const SEARCH_TEXT_SYNC_LIMIT = 64

const searchTextDirty = new Set<number>()
let searchTextTimer: NodeJS.Immediate | null = null

const SEARCH_TEXT_UPDATE_SQL = `UPDATE photos SET search_text = ${SEARCH_TEXT_EXPR}
  WHERE id IN (SELECT value FROM json_each(?))`

function updateSearchTextBatch(ids: number[]): void {
  stmt(SEARCH_TEXT_UPDATE_SQL).run(JSON.stringify(ids))
}

/** 立即重算全部待处理照片（关键词检索、导出备份、关闭库前调用，保证读后一致） */
export function flushSearchText(): void {
  if (!searchTextDirty.size) return
  const ids = [...searchTextDirty]
  searchTextDirty.clear()
  try {
    const run = db.transaction(() => {
      for (let i = 0; i < ids.length; i += SEARCH_TEXT_BATCH) {
        updateSearchTextBatch(ids.slice(i, i + SEARCH_TEXT_BATCH))
      }
    })
    run()
  } catch (err) {
    for (const id of ids) searchTextDirty.add(id)
    throw err
  }
}

/** 丢弃待处理队列：换库/关库后旧 id 对新库无意义，绝不能写入 */
function discardSearchTextQueue(): void {
  searchTextDirty.clear()
  if (searchTextTimer) {
    clearImmediate(searchTextTimer)
    searchTextTimer = null
  }
}

function scheduleSearchTextFlush(): void {
  if (searchTextTimer) return
  searchTextTimer = setImmediate(() => {
    searchTextTimer = null
    const ids: number[] = []
    for (const id of searchTextDirty) {
      ids.push(id)
      if (ids.length >= SEARCH_TEXT_BATCH) break
    }
    for (const id of ids) searchTextDirty.delete(id)
    try {
      if (ids.length) db.transaction(() => updateSearchTextBatch(ids))()
    } catch (err) {
      // 后台失败放回队列，留给下一次检索/关闭前重试，避免定时器空转
      for (const id of ids) searchTextDirty.add(id)
      logError('searchText', err)
      return
    }
    if (searchTextDirty.size) scheduleSearchTextFlush()
  })
}

/** 标记搜索文本待重算（名称+标题+描述+可见标签名+可见相册名）；FTS 触发器随更新同步 */
export function recomputeSearchText(ids: number[]): void {
  if (!ids.length) return
  for (const id of ids) searchTextDirty.add(id)
  // 事务内不能另开事务：交给事件循环在提交后处理
  if (db.inTransaction || searchTextDirty.size > SEARCH_TEXT_SYNC_LIMIT) {
    scheduleSearchTextFlush()
    return
  }
  flushSearchText()
}

/** 扫描等批量写入后合并 WAL（PASSIVE：不阻塞读写，失败静默） */
export function checkpointWalPassive(): void {
  try {
    db.pragma('wal_checkpoint(PASSIVE)')
  } catch {
    /* ignore */
  }
}

/** 检索前冲刷队列；失败时降级为略旧文本，不让搜索本身报错 */
function flushSearchTextForRead(): void {
  try {
    flushSearchText()
  } catch (err) {
    logError('searchText', err)
  }
}

export function updatePhotoFileFields(
  id: number,
  fields: { size?: number; mtime?: number; missing?: 0 | 1 },
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
    stmt('UPDATE photos SET path = ?, name = ?, mtime = ? WHERE id = ?').run(
      newPath,
      newName,
      mtime,
      id,
    )
  } else {
    stmt('UPDATE photos SET path = ?, name = ? WHERE id = ?').run(newPath, newName, id)
  }
  recomputeSearchText([id])
}

export function setPhotoDimsAndDate(
  id: number,
  width: number | null,
  height: number | null,
  takenAt: number | null,
): void {
  stmt('UPDATE photos SET width = ?, height = ?, taken_at = ? WHERE id = ?').run(
    width,
    height,
    takenAt,
    id,
  )
}

export function setThumbStatus(id: number, status: 0 | 1 | 2, ts?: number): void {
  stmt('UPDATE photos SET thumb_status = ?, thumb_ts = ? WHERE id = ?').run(
    status,
    ts ?? Date.now(),
    id,
  )
}

export function getPhotoRecord(id: number): PhotoRecord | undefined {
  const row = stmt(
    `SELECT ${PHOTO_LITE_COLS}, title, description, flip_h, flip_v, mtime FROM photos WHERE id = ?`,
  ).get(id) as Omit<PhotoRecord, 'tags' | 'albums'> | undefined
  if (!row) return undefined
  const tags = stmt(
    `SELECT t.id, t.name FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
     WHERE pt.photo_id = ? AND t.deleted_at IS NULL ORDER BY t.name`,
  ).all(id) as TagRef[]
  const albums = stmt(
    `SELECT a.id, a.name FROM album_photos ap JOIN albums a ON a.id = ap.album_id
     WHERE ap.photo_id = ? AND a.deleted_at IS NULL ORDER BY a.name`,
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
  },
): void {
  const allowed: Record<string, unknown> = {}
  for (const k of ['rating', 'title', 'description', 'orientation', 'flip_h', 'flip_v'] as const) {
    if (patch[k] === undefined) continue
    const v = patch[k]
    // IPC 边界钳制（OPT-32）：渲染层传入的异常值不入库
    if (k === 'rating') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      allowed[k] = Math.min(5, Math.max(0, Math.round(v)))
    } else if (k === 'orientation' || k === 'flip_h' || k === 'flip_v') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      allowed[k] = Math.trunc(v)
    } else {
      allowed[k] = v
    }
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
    chunkedIn(ids, (chunk, ph) => {
      stmt(`DELETE FROM photo_tags WHERE photo_id IN (${ph})`).run(...chunk)
      stmt(`DELETE FROM album_photos WHERE photo_id IN (${ph})`).run(...chunk)
      stmt(`DELETE FROM photos WHERE id IN (${ph})`).run(...chunk)
      return []
    })
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
      where.push(
        'EXISTS (SELECT 1 FROM album_photos ap JOIN albums a ON a.id = ap.album_id WHERE ap.photo_id = p.id AND ap.album_id = @scopeId AND a.deleted_at IS NULL)',
      )
      params.scopeId = q.scopeId
      break
    case 'tag':
      where.push(
        'EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id AND pt.tag_id = @scopeId AND t.deleted_at IS NULL)',
      )
      params.scopeId = q.scopeId
      break
    case 'untagged':
      where.push(
        'NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id AND t.deleted_at IS NULL)',
      )
      break
    case 'missing':
      where.push('p.missing = 1')
      break
    case 'map':
      // 地点作用域：仅含已解析 GPS 的照片（列表分页，供网格复用）
      where.push('p.gps_lat IS NOT NULL AND p.gps_lon IS NOT NULL')
      break
    default:
      break
  }
  // 已移除资料库（软删除文件夹）中的照片不进入任何视图（含回收站），恢复后自动回归
  where.push(VISIBLE_FOLDER_SQL)
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
  // 智能相册的附加条件：多标签 AND（每个标签一个 EXISTS），多相册/文件夹 OR
  if (q.tagIds?.length) {
    q.tagIds.forEach((id, i) => {
      where.push(
        `EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.photo_id = p.id AND pt.tag_id = @tag${i} AND t.deleted_at IS NULL)`,
      )
      params[`tag${i}`] = id
    })
  }
  if (q.albumIds?.length) {
    const marks = q.albumIds.map((id, i) => {
      params[`album${i}`] = id
      return `@album${i}`
    })
    where.push(
      `EXISTS (SELECT 1 FROM album_photos ap JOIN albums a ON a.id = ap.album_id
        WHERE ap.photo_id = p.id AND ap.album_id IN (${marks.join(', ')}) AND a.deleted_at IS NULL)`,
    )
  }
  if (q.folderIds?.length) {
    const marks = q.folderIds.map((id, i) => {
      params[`folder${i}`] = id
      return `@folder${i}`
    })
    where.push(`p.folder_id IN (${marks.join(', ')})`)
  }
  if (q.untagged) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.photo_id = p.id AND t.deleted_at IS NULL)`,
    )
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
  const resolved = resolveSmartFilters(q)
  // 检索前冲刷脏队列：批量打标签/入相册后立刻搜索也能命中最新文本
  if (resolved.keyword?.trim()) flushSearchTextForRead()
  const { whereSql, params } = buildPhotoFilter(resolved)
  // 排序也取解析后的条件：智能相册可固定自己的排序方式
  const orderSql = buildOrderSql(resolved)
  const limit = Math.min(q.limit ?? 50000, 100000)
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  // 窗口函数在单次查询中同时返回总数，避免额外的 COUNT 扫描。
  // LIMIT/OFFSET 参数绑定（OPT-30）：数值不再内插进 SQL 文本，翻页/换页大小
  // 均复用同一预编译语句，stmtCache 不会随浏览无界增长
  const rows = stmt(
    `SELECT ${PHOTO_LITE_COLS}, COUNT(*) OVER() AS _total FROM photos p ${whereSql} ${orderSql} LIMIT @_limit OFFSET @_offset`,
  ).all({ ...params, _limit: limit, _offset: offset }) as (PhotoLite & { _total?: number })[]
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
  const resolved = resolveSmartFilters(q)
  if (resolved.keyword?.trim()) flushSearchTextForRead()
  const { whereSql, params } = buildPhotoFilter(resolved)
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
      return {
        ...q,
        keyword: saved.keyword,
        dateFrom: saved.dateFrom,
        dateTo: saved.dateTo,
        minRating: saved.minRating,
        tagIds: saved.tagIds,
        albumIds: saved.albumIds,
        folderIds: saved.folderIds,
        untagged: saved.untagged,
        sort: saved.sort ?? q.sort,
        dir: saved.dir ?? q.dir,
      }
    }
  }
  return q
}

/* ---------- smart albums ---------- */

export function listSmartAlbums(): SmartAlbumInfo[] {
  const rows = stmt(
    'SELECT id, name, color, created_at, query FROM smart_albums WHERE deleted_at IS NULL ORDER BY created_at ASC',
  ).all() as (Omit<SmartAlbumInfo, 'query'> & { query: string })[]
  return rows.map((r) => ({ ...r, query: parseSmartQuery(r.query) }))
}

/**
 * 智能相册条件逐字段校验：query 由渲染层任意 JSON 持久化，损坏/旧版本/非法值若
 * 直接进入 buildPhotoFilter（如 keyword 为非字符串时 .trim() 抛 TypeError、dateFrom
 * 为数字时 better-sqlite3 拒绝绑定 NaN），photos:query 会持续报错且该相册在 UI 中
 * 无法打开修复。这里按字段类型白名单过滤：非法字段一律丢弃（视为未设置），合法
 * 语义不变（minRating ≤0 与原实现同样视为无过滤）。
 */
const SMART_SORT_KEYS = new Set(['taken', 'imported', 'name', 'rating', 'size'])

function parseSmartQuery(raw: string): SmartAlbumQuery {
  let q: unknown
  try {
    q = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof q !== 'object' || q === null || Array.isArray(q)) return {}
  const src = q as Record<string, unknown>
  const out: SmartAlbumQuery = {}
  if (typeof src.keyword === 'string') out.keyword = src.keyword
  if (typeof src.dateFrom === 'string') out.dateFrom = src.dateFrom
  if (typeof src.dateTo === 'string') out.dateTo = src.dateTo
  if (typeof src.minRating === 'number' && Number.isFinite(src.minRating) && src.minRating >= 1) {
    out.minRating = Math.min(5, Math.floor(src.minRating))
  }
  const idsOf = (v: unknown): number[] | undefined => {
    if (!Array.isArray(v)) return undefined
    const arr = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    return arr.length ? arr : undefined
  }
  const tagIds = idsOf(src.tagIds)
  if (tagIds) out.tagIds = tagIds
  const albumIds = idsOf(src.albumIds)
  if (albumIds) out.albumIds = albumIds
  const folderIds = idsOf(src.folderIds)
  if (folderIds) out.folderIds = folderIds
  if (typeof src.untagged === 'boolean') out.untagged = src.untagged
  if (typeof src.sort === 'string' && SMART_SORT_KEYS.has(src.sort)) {
    out.sort = src.sort as SmartAlbumQuery['sort']
  }
  if (src.dir === 'asc' || src.dir === 'desc') out.dir = src.dir
  return out
}

export function getSmartAlbumQuery(id: number): SmartAlbumQuery | undefined {
  const row = stmt('SELECT query FROM smart_albums WHERE id = ? AND deleted_at IS NULL').get(id) as
    { query: string } | undefined
  return row ? parseSmartQuery(row.query) : undefined
}

export function createSmartAlbum(name: string, query: SmartAlbumQuery): number {
  const info = stmt(
    'INSERT INTO smart_albums (name, color, query, created_at) VALUES (?, NULL, ?, ?)',
  ).run(name, JSON.stringify(query), Date.now())
  return Number(info.lastInsertRowid)
}

export function renameSmartAlbum(id: number, name: string): void {
  stmt('UPDATE smart_albums SET name = ? WHERE id = ?').run(name, id)
}

/** 编辑智能相册：名称与条件一并更新，下次查询按新条件解析 */
export function updateSmartAlbum(id: number, name: string, query: SmartAlbumQuery): void {
  stmt('UPDATE smart_albums SET name = ?, query = ? WHERE id = ?').run(
    name,
    JSON.stringify(query),
    id,
  )
}

/** 智能相册软删除（FEAT-13）：与普通相册的删除/撤销体系对齐 */
export function deleteSmartAlbum(id: number): { name: string; photos: number } | null {
  const row = stmt('SELECT name FROM smart_albums WHERE id = ? AND deleted_at IS NULL').get(id) as
    { name: string } | undefined
  if (!row) return null
  // 命中的照片数需在软删前统计（getSmartAlbumQuery 此后将排除已删行）
  const photos = queryPhotos({ scope: 'smart', scopeId: id }).total
  stmt('UPDATE smart_albums SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
  return { name: row.name, photos }
}

/** 撤销删除智能相册 */
export function restoreSmartAlbum(id: number): { name: string; photos: number } | null {
  const row = stmt('SELECT name FROM smart_albums WHERE id = ? AND deleted_at IS NOT NULL').get(
    id,
  ) as { name: string } | undefined
  if (!row) return null
  stmt('UPDATE smart_albums SET deleted_at = NULL WHERE id = ?').run(id)
  return { name: row.name, photos: queryPhotos({ scope: 'smart', scopeId: id }).total }
}

/* ---------- tags ---------- */

export function listTags(): TagInfo[] {
  return stmt(
    `SELECT t.id, t.name, t.color,
      (SELECT COUNT(*) FROM photo_tags pt JOIN photos p ON p.id = pt.photo_id
        WHERE pt.tag_id = t.id AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}) AS count
     FROM tags t WHERE t.deleted_at IS NULL ORDER BY t.name COLLATE NOCASE`,
  ).all() as TagInfo[]
}

export function createTag(name: string, color: string | null): TagInfo {
  // 同名标签已软删除：视为「撤销删除」而非冲突——复活原行，保留既有照片关系
  const existing = stmt('SELECT id, deleted_at FROM tags WHERE name = ?').get(name) as
    { id: number; deleted_at: number | null } | undefined
  if (existing) {
    if (existing.deleted_at === null) throw new Error(`标签「${name}」已存在`)
    stmt('UPDATE tags SET deleted_at = NULL, color = ? WHERE id = ?').run(color, existing.id)
    const affected = (
      stmt('SELECT photo_id FROM photo_tags WHERE tag_id = ?').all(existing.id) as {
        photo_id: number
      }[]
    ).map((r) => r.photo_id)
    recomputeSearchText(affected)
    return { id: existing.id, name, color, count: 0 }
  }
  const info = stmt('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)').run(name, color)
  if (info.changes === 0) {
    throw new Error(`标签「${name}」已存在`)
  }
  return { id: Number(info.lastInsertRowid), name, color, count: 0 }
}

export function renameTag(id: number, name: string): void {
  const affected = (
    stmt('SELECT photo_id FROM photo_tags WHERE tag_id = ?').all(id) as { photo_id: number }[]
  ).map((r) => r.photo_id)
  stmt('UPDATE tags SET name = ? WHERE id = ? AND deleted_at IS NULL').run(name, id)
  recomputeSearchText(affected)
}

export function setTagColor(id: number, color: string | null): void {
  stmt('UPDATE tags SET color = ? WHERE id = ? AND deleted_at IS NULL').run(color, id)
}

export function setAlbumColor(id: number, color: string | null): void {
  stmt('UPDATE albums SET color = ? WHERE id = ? AND deleted_at IS NULL').run(color, id)
}

function countTagPhotos(tagId: number): number {
  return (
    stmt(
      `SELECT COUNT(*) AS c FROM photo_tags pt JOIN photos p ON p.id = pt.photo_id
        WHERE pt.tag_id = ? AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
    ).get(tagId) as { c: number }
  ).c
}

/** 软删除标签：保留 photo_tags 关系，清除/恢复仅需翻转 deleted_at，可即时撤销 */
/**
 * 标签/相册软删的公共实现（OPT-35 去重）：两域结构完全一致——查名 → 统计照片 →
 * 收集受影响照片 → 翻转 deleted_at → 重算检索文本。表/关联列来自固定集合，无注入面。
 */
function softDeleteNamed(
  table: 'tags' | 'albums',
  relColumn: 'tag_id' | 'album_id',
  countFn: (id: number) => number,
  id: number,
): { name: string; photos: number } | null {
  const row = stmt(`SELECT name FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id) as
    { name: string } | undefined
  if (!row) return null
  const photos = countFn(id)
  const affected = (
    stmt(
      `SELECT photo_id FROM ${table === 'tags' ? 'photo_tags' : 'album_photos'} WHERE ${relColumn} = ?`,
    ).all(id) as { photo_id: number }[]
  ).map((r) => r.photo_id)
  stmt(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(Date.now(), id)
  // 名称参与检索文本：删除后需从受影响照片的 search_text 中移除
  recomputeSearchText(affected)
  return { name: row.name, photos }
}

/** 撤销删除标签/相册：恢复 deleted_at 并把名称重新写回检索文本 */
function restoreNamed(
  table: 'tags' | 'albums',
  relColumn: 'tag_id' | 'album_id',
  countFn: (id: number) => number,
  id: number,
): { name: string; photos: number } | null {
  const row = stmt(`SELECT name FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`).get(id) as
    { name: string } | undefined
  if (!row) return null
  const photos = countFn(id)
  const affected = (
    stmt(
      `SELECT photo_id FROM ${table === 'tags' ? 'photo_tags' : 'album_photos'} WHERE ${relColumn} = ?`,
    ).all(id) as { photo_id: number }[]
  ).map((r) => r.photo_id)
  stmt(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(id)
  recomputeSearchText(affected)
  return { name: row.name, photos }
}

export function deleteTag(id: number): { name: string; photos: number } | null {
  return softDeleteNamed('tags', 'tag_id', countTagPhotos, id)
}

/** 撤销删除标签：恢复 deleted_at 并把标签名重新写回检索文本 */
export function restoreTag(id: number): { name: string; photos: number } | null {
  return restoreNamed('tags', 'tag_id', countTagPhotos, id)
}

export function setPhotoTags(photoId: number, tagIds: number[]): void {
  const run = db.transaction(() => {
    // 只替换可见标签关系；已软删除标签的关联保留在库中，撤销删除时可原样恢复
    stmt(
      'DELETE FROM photo_tags WHERE photo_id = ? AND tag_id IN (SELECT id FROM tags WHERE deleted_at IS NULL)',
    ).run(photoId)
    // 只接受未删除标签：陈旧 UI 传入的已删 id 静默丢弃，避免恢复后意外复活关系
    const ins = stmt(
      'INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) SELECT ?, id FROM tags WHERE id = ? AND deleted_at IS NULL',
    )
    for (const t of tagIds) ins.run(photoId, t)
  })
  run()
  recomputeSearchText([photoId])
}

export function batchTags(ids: number[], addTagIds: number[], removeTagIds: number[]): void {
  if (!ids.length) return
  // 集合写入：每条语句处理整批 id（json_each 无变量上限），避免 ids × tags 次往返
  const idSet = JSON.stringify(ids)
  const run = db.transaction(() => {
    for (const tagId of removeTagIds) {
      stmt(
        'DELETE FROM photo_tags WHERE tag_id = ? AND photo_id IN (SELECT value FROM json_each(?))',
      ).run(tagId, idSet)
    }
    for (const tagId of addTagIds) {
      // 只接受未删除标签：陈旧 UI 传入的已删 id 静默丢弃，避免恢复后意外复活关系
      stmt(
        `INSERT OR IGNORE INTO photo_tags (photo_id, tag_id)
         SELECT p.id, ? FROM photos p
         WHERE p.id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND deleted_at IS NULL)`,
      ).run(tagId, idSet, tagId)
    }
  })
  run()
  recomputeSearchText(ids)
}

export function batchRate(ids: number[], rating: number): void {
  if (!ids.length) return
  // IPC 边界钳制（OPT-32）：异常评分不入库
  const clamped =
    typeof rating === 'number' && Number.isFinite(rating)
      ? Math.min(5, Math.max(0, Math.round(rating)))
      : 0
  stmt('UPDATE photos SET rating = ? WHERE id IN (SELECT value FROM json_each(?))').run(
    clamped,
    JSON.stringify(ids),
  )
}

/* ---------- albums ---------- */

export function listAlbums(): AlbumInfo[] {
  return stmt(
    `SELECT a.id, a.name, a.color, a.created_at,
      (SELECT COUNT(*) FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
        WHERE ap.album_id = a.id AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}) AS count,
      (SELECT ap.photo_id FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
        WHERE ap.album_id = a.id AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL} LIMIT 1) AS cover_id,
      (SELECT p.thumb_ts FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
        WHERE ap.album_id = a.id AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL} LIMIT 1) AS cover_thumb_ts
     FROM albums a WHERE a.deleted_at IS NULL ORDER BY a.created_at ASC`,
  ).all() as AlbumInfo[]
}

export function createAlbum(name: string, color: string | null): number {
  const info = stmt('INSERT INTO albums (name, color, created_at) VALUES (?, ?, ?)').run(
    name,
    color,
    Date.now(),
  )
  return Number(info.lastInsertRowid)
}

export function renameAlbum(id: number, name: string): void {
  stmt('UPDATE albums SET name = ? WHERE id = ? AND deleted_at IS NULL').run(name, id)
  // 相册名参与检索：成员可能很多，交给脏队列后台重算（v12 起不再由触发器逐行更新）
  const affected = (
    stmt('SELECT photo_id FROM album_photos WHERE album_id = ?').all(id) as {
      photo_id: number
    }[]
  ).map((r) => r.photo_id)
  recomputeSearchText(affected)
}

function countAlbumPhotos(albumId: number): number {
  return (
    stmt(
      `SELECT COUNT(*) AS c FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
        WHERE ap.album_id = ? AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
    ).get(albumId) as { c: number }
  ).c
}

/** 软删除相册：保留 album_photos 关系，撤销时清除 deleted_at 即可恢复成员 */
export function deleteAlbum(id: number): { name: string; photos: number } | null {
  return softDeleteNamed('albums', 'album_id', countAlbumPhotos, id)
}

/** 撤销删除相册：恢复 deleted_at 并把相册名重新写回检索文本 */
export function restoreAlbum(id: number): { name: string; photos: number } | null {
  return restoreNamed('albums', 'album_id', countAlbumPhotos, id)
}

export function batchAlbum(ids: number[], albumId: number | null): void {
  if (!ids.length) return
  const idSet = JSON.stringify(ids)
  if (albumId === null) {
    stmt('DELETE FROM album_photos WHERE photo_id IN (SELECT value FROM json_each(?))').run(idSet)
  } else {
    // 已删除相册不接收新成员（陈旧 UI 传入的 id 静默忽略）
    const visible = stmt('SELECT 1 FROM albums WHERE id = ? AND deleted_at IS NULL').get(albumId)
    if (!visible) return
    stmt(
      `INSERT OR IGNORE INTO album_photos (album_id, photo_id)
       SELECT ?, p.id FROM photos p WHERE p.id IN (SELECT value FROM json_each(?))`,
    ).run(albumId, idSet)
  }
  // 相册名参与检索文本；成员变更不再由触发器逐行重算，统一入队后台刷新
  recomputeSearchText(ids)
}

export function removeFromAlbum(photoId: number, albumId: number): void {
  const changed = stmt('DELETE FROM album_photos WHERE photo_id = ? AND album_id = ?').run(
    photoId,
    albumId,
  ).changes
  if (changed) recomputeSearchText([photoId])
}

/* ---------- stats ---------- */

/* ---------- 回收站（软删除） ---------- */

/** 软删除：索引移入回收站视图，磁盘文件保留在原位置；返回实际更新的行数 */
export function softDeletePhotos(ids: number[]): number {
  if (!ids.length) return 0
  const info = stmt(
    'UPDATE photos SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))',
  ).run(Date.now(), JSON.stringify(ids))
  // 已删行不再参与相似聚类
  markPhashDirty()
  return info.changes
}

/** 还原：清除 deleted_at，照片立即回到原作用域 */
export function restorePhotos(ids: number[]): number {
  if (!ids.length) return 0
  const info = stmt(
    'UPDATE photos SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?))',
  ).run(JSON.stringify(ids))
  markPhashDirty()
  return info.changes
}

/** 按路径查找已在回收站中的照片（watcher 检测到文件重新出现时自动还原用） */
export function findDeletedPhotoId(photoPath: string): number | null {
  const row = stmt(
    'SELECT id FROM photos WHERE path = ? COLLATE NOCASE AND deleted_at IS NOT NULL',
  ).get(photoPath) as { id: number } | undefined
  return row?.id ?? null
}

/** 指定 id 中已在回收站内的行（彻底删除前的安全过滤） */
export function listDeletedRows(ids: number[]): { id: number; path: string }[] {
  if (!ids.length) return []
  return chunkedIn(ids, (chunk, ph) =>
    stmt(
      `SELECT p.id, p.path FROM photos p WHERE p.deleted_at IS NOT NULL AND ${VISIBLE_FOLDER_SQL} AND p.id IN (${ph})`,
    ).all(...chunk) as { id: number; path: string }[],
  )
}

/** 回收站全部行（清空回收站用；已移除文件夹中的照片不参与） */
export function listAllDeletedRows(): { id: number; path: string }[] {
  return stmt(
    `SELECT p.id, p.path FROM photos p WHERE p.deleted_at IS NOT NULL AND ${VISIBLE_FOLDER_SQL}`,
  ).all() as {
    id: number
    path: string
  }[]
}

/* ---------- stats ---------- */

export function listPhotoIdsForRebuild(): number[] {
  const rows = stmt(
    `SELECT p.id FROM photos p WHERE p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
  ).all() as { id: number }[]
  return rows.map((r) => r.id)
}

/** 上次退出时未完成或曾失败缩略图生成的照片（用于启动续跑；失败行获得自动重试机会） */
export function listPhotoIdsPendingThumb(): number[] {
  const rows = stmt(
    `SELECT p.id FROM photos p WHERE p.thumb_status IN (0, 2) AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
  ).all() as { id: number }[]
  return rows.map((r) => r.id)
}

/** 全量照片 id（孤儿缩略图清理用；含回收站照片——还原时缩略图需即时可用） */
export function listAllPhotoIds(): number[] {
  const rows = stmt('SELECT id FROM photos').all() as { id: number }[]
  return rows.map((r) => r.id)
}

/* ---------- EXIF 扩展元数据（GPS / 相机，FEAT-07/08） ---------- */

export function setPhotoGps(id: number, lat: number, lon: number): void {
  stmt('UPDATE photos SET gps_lat = ?, gps_lon = ? WHERE id = ?').run(lat, lon, id)
}

export function markGpsChecked(id: number): void {
  stmt('UPDATE photos SET gps_checked = 1 WHERE id = ?').run(id)
}

export function setPhotoCamera(id: number, camera: string | null): void {
  stmt('UPDATE photos SET camera = ? WHERE id = ?').run(camera, id)
}

/** GPS 回填队列的待处理行：未尝试解析且仍在库中的照片 */
export function listPhotoIdsForGps(): number[] {
  const rows = stmt(
    `SELECT p.id FROM photos p
     WHERE p.gps_checked = 0 AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
  ).all() as { id: number }[]
  return rows.map((r) => r.id)
}

/** 地点视图数据：已解析 GPS 的照片精简行（上限 2 万，防极端大库渲染过载） */
export function listGeoPhotos(): {
  id: number
  name: string
  lat: number
  lon: number
  thumb_ts: number
  taken_at: number | null
}[] {
  return stmt(
    `SELECT p.id, p.name, p.gps_lat AS lat, p.gps_lon AS lon, p.thumb_ts, p.taken_at
     FROM photos p
     WHERE p.gps_lat IS NOT NULL AND p.gps_lon IS NOT NULL
       AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}
     ORDER BY p.taken_at DESC LIMIT 20000`,
  ).all() as never
}

/* ---------- 感知哈希（相似照片检测） ---------- */

export function setPhotoPhash(id: number, lo: number, hi: number): void {
  stmt('UPDATE photos SET phash_lo = ?, phash_hi = ? WHERE id = ?').run(lo, hi, id)
}

/** 增强数据（翻转哈希 + 颜色均值）写入并标记已补算（FEAT-17） */
export function setPhotoPhashExtra(id: number, flo: number, fhi: number, cm: number): void {
  stmt(
    'UPDATE photos SET phash_flip_lo = ?, phash_flip_hi = ?, color_mean = ?, phash_x_checked = 1 WHERE id = ?',
  ).run(flo, fhi, cm, id)
}

/** 哈希补算队列的待处理行：缺主哈希，或缺增强数据（FEAT-17 存量回填） */
export function listPhotosForPhash(): { id: number; path: string }[] {
  return stmt(
    `SELECT p.id, p.path FROM photos p
     WHERE (p.phash_lo IS NULL OR p.phash_x_checked = 0) AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
  ).all() as {
    id: number
    path: string
  }[]
}

export function listPhashes(): { id: number; lo: number; hi: number; flo: number; fhi: number; cm: number }[] {
  return stmt(
    `SELECT p.id, p.phash_lo AS lo, p.phash_hi AS hi,
            COALESCE(p.phash_flip_lo, p.phash_lo) AS flo,
            COALESCE(p.phash_flip_hi, p.phash_hi) AS fhi,
            COALESCE(p.color_mean, 0) AS cm
     FROM photos p
     WHERE p.phash_lo IS NOT NULL AND p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
  ).all() as { id: number; lo: number; hi: number; flo: number; fhi: number; cm: number }[]
}

/** 聚类结果缓存（保留簇边界）：哈希/缺失/删除变化后置脏，下次查询在 worker 中重算 */
let dupClustersCache: number[][] | null = null
/** 置脏代次：计算期间再次置脏时，本次结果作废不缓存，下次查询重算 */
let dupGen = 0
let dupInflight: Promise<number[][]> | null = null

export function markPhashDirty(): void {
  dupGen++
  dupClustersCache = null
}

/** 相似聚类阈值设置：汉明距离上限，越小越严格；非法值回落标准 6 */
export function phashThreshold(): number {
  try {
    const raw = getSetting('phashThreshold')
    if (raw === null || raw === '') return 6
    const n = Number(raw)
    return Number.isFinite(n) ? Math.min(12, Math.max(2, Math.floor(n))) : 6
  } catch {
    return 6
  }
}

/**
 * 疑似重复簇（仅含成员数 ≥ 2 的簇）。
 * 聚类在 worker 线程执行，不阻塞主进程；并发调用合并为同一次计算。
 */
export async function duplicateClusters(): Promise<number[][]> {
  if (dupClustersCache) return dupClustersCache
  // 已有计算在跑时直接复用：哈希补算期间置脏非常频繁，若每个代次都新起一次
  // 全量聚类，worker 队列会堆积多次秒级任务。这里允许返回略旧结果（不缓存），
  // 下一次查询自然用最新代次重算。
  if (dupInflight) return dupInflight
  const myGen = dupGen
  const promise = (async (): Promise<number[][]> => {
    const rows = listPhashes().sort((a, b) => a.id - b.id)
    return (await computePhashClusters(rows, phashThreshold())).filter((c) => c.length >= 2)
  })()
  dupInflight = promise
  let result: number[][]
  try {
    result = await promise
  } finally {
    if (dupInflight === promise) dupInflight = null
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
export async function queryDuplicates(q: {
  limit?: number
  offset?: number
}): Promise<QueryResult> {
  const ids = await duplicatePhotoIds()
  const limit = Math.min(q.limit ?? 50000, 100000)
  const offset = Math.max(0, Math.floor(q.offset ?? 0))
  // id 来源于自身库，但入口仍按类型约束过滤非有限值（OPT-32），异常数据不会进入 SQL
  const slice = ids.slice(offset, offset + limit).filter((id) => Number.isInteger(id) && id > 0)
  if (!slice.length) return { items: [], total: ids.length }
  // 分块 IN 查询 + 内存按 ids 顺序重排（OPT-44）：原先把整段 id 列表直接作为绑定
  // 参数并用 CASE WHEN 内插排序，重复照片超过 SQLite 变量上限（32766）时默认调用
  // 路径必抛「Too many parameter variables」，且数万分支的 SQL 文本达 MB 级反复解析
  const byId = new Map<number, PhotoLite>(
    chunkedIn(slice, (chunk, ph) =>
      stmt(`SELECT ${PHOTO_LITE_COLS} FROM photos p WHERE p.id IN (${ph})`).all(chunk) as PhotoLite[]
    ).map((p) => [p.id, p])
  )
  // 簇计算与查询之间被彻底删除的照片行自然缺失，与原 WHERE 语义一致：跳过即可
  const items = slice
    .map((id) => byId.get(id))
    .filter((p): p is PhotoLite => p !== undefined)
  return { items, total: ids.length }
}

/** 统计分布（FEAT-08）：聚合查询，全部限定可见文件夹 + 未删除 */
export function libraryDistribution(): LibraryDistribution {
  const byMonth = (
    stmt(
      `SELECT strftime('%Y-%m', p.sort_ts / 1000, 'unixepoch') AS ym, COUNT(*) AS count
       FROM photos p WHERE ${VISIBLE_FOLDER_SQL} AND p.deleted_at IS NULL
       GROUP BY ym ORDER BY ym DESC LIMIT 24`,
    ).all() as { ym: string; count: number }[]
  ).reverse()
  const ratingRows = (
    stmt(
      `SELECT p.rating AS rating, COUNT(*) AS count
       FROM photos p WHERE ${VISIBLE_FOLDER_SQL} AND p.deleted_at IS NULL GROUP BY p.rating`,
    ).all() as { rating: number; count: number }[]
  )
  const byRating = [0, 0, 0, 0, 0, 0]
  for (const r of ratingRows) {
    const i = Math.min(5, Math.max(0, Math.round(r.rating)))
    byRating[i] = r.count
  }
  const topTags = (
    stmt(
      `SELECT t.name AS name, COUNT(*) AS count FROM photo_tags pt
       JOIN tags t ON t.id = pt.tag_id AND t.deleted_at IS NULL
       JOIN photos p ON p.id = pt.photo_id AND p.missing = 0 AND p.deleted_at IS NULL
       WHERE ${VISIBLE_FOLDER_SQL} GROUP BY t.id ORDER BY count DESC LIMIT 10`,
    ).all() as { name: string; count: number }[]
  )
  const byCamera = (
    stmt(
      `SELECT p.camera AS name, COUNT(*) AS count
       FROM photos p WHERE ${VISIBLE_FOLDER_SQL} AND p.deleted_at IS NULL AND p.camera IS NOT NULL
       GROUP BY p.camera ORDER BY count DESC LIMIT 8`,
    ).all() as { name: string; count: number }[]
  )
  return { byMonth, byRating, topTags, byCamera }
}

export function libraryStats(): {
  total: number
  missing: number
  untagged: number
  trash: number
} {
  const total = (
    stmt(
      `SELECT COUNT(*) AS c FROM photos p WHERE p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
    ).get() as {
      c: number
    }
  ).c
  const missing = (
    stmt(
      `SELECT COUNT(*) AS c FROM photos p WHERE p.missing = 1 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}`,
    ).get() as {
      c: number
    }
  ).c
  const untagged = (
    stmt(
      `SELECT COUNT(*) AS c FROM photos p WHERE p.missing = 0 AND p.deleted_at IS NULL AND ${VISIBLE_FOLDER_SQL}
        AND NOT EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                        WHERE pt.photo_id = p.id AND t.deleted_at IS NULL)`,
    ).get() as { c: number }
  ).c
  const trash = (
    stmt(
      `SELECT COUNT(*) AS c FROM photos p WHERE p.deleted_at IS NOT NULL AND ${VISIBLE_FOLDER_SQL}`,
    ).get() as { c: number }
  ).c
  return { total, missing, untagged, trash }
}
