import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import sharp from 'sharp'
import exifr from 'exifr'
import { BrowserWindow, app } from 'electron'
import {
  getPhotoRow,
  getSetting,
  listAllPhotoIds,
  listPhotoIdsForRebuild,
  setPhotoDimsAndDate,
  setThumbStatus,
} from './db'
import { enqueuePhash } from './phash'
import { logError } from './log'
import { isRawExt } from '@shared/formats'
import { extractRawPreviewPair } from './rawPreview'
import type { CleanupResult, ThumbEvent } from '@shared/types'

const CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 1))

const queue: number[] = []
const queued = new Set<number>()
let running = 0

/** 库代次：换库（备份导入）后递增；在途任务按开始时捕获的代次校验，过期写入作废 */
let generation = 0

export function bumpThumbGeneration(): void {
  generation++
}

/** 当前库代次：thumbs 队列之外的旁路写盘方（如 previewService）捕获校验用 */
export function currentThumbGeneration(): number {
  return generation
}

/** 瞬时失败重试（短暂文件锁/杀毒扫描等）：有限次数 + 递增退避；耗尽后进入失败态 */
const THUMB_RETRY_DELAYS = [1000, 3000]
const thumbRetries = new Map<number, number>()

export function thumbsDir(): string {
  return path.join(app.getPath('userData'), 'thumbs')
}

export function backupsDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

export function thumbPath(id: number): string {
  return path.join(thumbsDir(), `${id}.webp`)
}

/** RAW 照片的嵌入预览（查看器显示源） */
export function previewPath(id: number): string {
  return path.join(thumbsDir(), `${id}.preview.jpg`)
}

/** 预览落盘用临时文件 + rename：崩溃不会留下可被当作完整预览返回的半成品 */
export async function writePreviewFile(target: string, buf: Buffer): Promise<void> {
  const tmp = `${target}.tmp`
  try {
    await fs.promises.writeFile(tmp, buf)
    // Windows 的 rename 不能覆盖已存在目标；缓存可重建，先移除再落位
    await fs.promises.rm(target, { force: true })
    await fs.promises.rename(tmp, target)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** 缩略图落盘用临时文件 + rename：与预览落盘同款保护——崩溃不会留下半截 webp
 * 被 `?v=thumb_ts` immutable 缓存头永久固化（thumb_ts 不再变化，孤儿清理也无法识别） */
async function writeThumbFile(target: string, pipe: sharp.Sharp): Promise<void> {
  const tmp = `${target}.tmp`
  try {
    await pipe.toFile(tmp)
    await fs.promises.rm(target, { force: true })
    await fs.promises.rename(tmp, target)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/* ---------- RAW 预览缓存预算 ---------- */

const PREVIEW_BUDGET_KEY = 'previewBudgetMb'
/** 默认 1 GB：约容纳 80–150 张全尺寸 RAW 预览；超出后按最旧优先淘汰，查看时按需重建 */
export const DEFAULT_PREVIEW_BUDGET_MB = 1024

/** 当前预览缓存预算（MB）；0 表示不限制，非法值回落默认 */
export function previewBudgetMb(): number {
  try {
    const raw = getSetting(PREVIEW_BUDGET_KEY)
    if (raw === null || raw === '') return DEFAULT_PREVIEW_BUDGET_MB
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PREVIEW_BUDGET_MB
  } catch {
    return DEFAULT_PREVIEW_BUDGET_MB
  }
}

/** 预览缓存占用（仅统计 *.preview.jpg） */
export function previewStats(): { bytes: number; files: number } {
  const dir = thumbsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { bytes: 0, files: 0 }
  }
  let bytes = 0
  let files = 0
  for (const name of names) {
    if (!name.endsWith('.preview.jpg')) continue
    try {
      const st = fs.statSync(path.join(dir, name))
      if (st.isFile()) {
        bytes += st.size
        files++
      }
    } catch {
      /* 单文件不可读忽略 */
    }
  }
  return { bytes, files }
}

/** 清空全部 RAW 预览缓存；查看/导出时按需重建，不影响照片文件 */
export function clearPreviews(): CleanupResult {
  const dir = thumbsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { deleted: 0, bytes: 0 }
  }
  let deleted = 0
  let bytes = 0
  for (const name of names) {
    if (!name.endsWith('.preview.jpg')) continue
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      fs.rmSync(p, { force: true })
      deleted++
      bytes += st.size
    } catch {
      /* 被占用或已删除：跳过 */
    }
  }
  return { deleted, bytes }
}

/**
 * 按预算淘汰最旧的 RAW 预览（mtime 近似 LRU；协议层每次读取会 touch mtime）。
 * 预算为 0 时不限制。单个预览大于预算时也会保留最新一份，避免"永远无法显示"。
 */
export function enforcePreviewBudget(): CleanupResult {
  const budget = previewBudgetMb() * 1024 * 1024
  if (!budget) return { deleted: 0, bytes: 0 }
  const dir = thumbsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { deleted: 0, bytes: 0 }
  }
  const entries: { name: string; path: string; size: number; mtimeMs: number }[] = []
  let total = 0
  for (const name of names) {
    if (!name.endsWith('.preview.jpg')) continue
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) continue
      entries.push({ name, path: p, size: st.size, mtimeMs: st.mtimeMs })
      total += st.size
    } catch {
      /* 单文件不可读忽略 */
    }
  }
  if (total <= budget) return { deleted: 0, bytes: 0 }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  let deleted = 0
  let bytes = 0
  // 始终保留最新一份：单张预览本身超预算时也不删除，否则会陷入"查看→重建→再删除"
  for (let i = 0; i < entries.length - 1; i++) {
    if (total <= budget) break
    const e = entries[i]
    try {
      fs.rmSync(e.path, { force: true })
      total -= e.size
      bytes += e.size
      deleted++
    } catch {
      /* 被占用或已删除：跳过 */
    }
  }
  return { deleted, bytes }
}

let previewBudgetTimer: ReturnType<typeof setTimeout> | null = null

/** 预览写入后延迟检查预算：合并批量导入期间的连续写入，避免每张都全目录扫描 */
export function schedulePreviewBudgetCheck(delay = 2000): void {
  if (previewBudgetTimer) clearTimeout(previewBudgetTimer)
  previewBudgetTimer = setTimeout(() => {
    previewBudgetTimer = null
    try {
      enforcePreviewBudget()
    } catch (err) {
      logError('previewBudget', err)
    }
  }, delay)
}

function emit(e: ThumbEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('evt:thumb', e)
  }
}

export function enqueueThumb(id: number): void {
  if (queued.has(id)) return
  queued.add(id)
  queue.push(id)
  pump()
}

export function dequeueThumb(id: number): void {
  if (!queued.has(id)) return
  const i = queue.indexOf(id)
  if (i >= 0) queue.splice(i, 1)
  queued.delete(id)
}

/** 清空待生成队列（进行中的单张会自然完成），返回被移除的数量；剩余照片下次启动续跑 */
export function clearThumbQueue(): number {
  const drained = queue.length
  queue.length = 0
  queued.clear()
  return drained
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!
    queued.delete(id)
    running++
    run(id)
      .catch(() => undefined)
      .finally(() => {
        running--
        pump()
      })
  }
}

async function readTakenAt(src: string | Uint8Array): Promise<number | null> {
  try {
    const d = await exifr.parse(src, {
      tiff: true,
      exif: true,
      gps: false,
      xmp: false,
      icc: false,
      iptc: false
    })
    const raw = d?.DateTimeOriginal ?? d?.CreateDate ?? d?.ModifyDate
    if (raw instanceof Date && !isNaN(raw.getTime())) return raw.getTime()
    if (typeof raw === 'string') {
      const t = Date.parse(raw)
      if (!isNaN(t)) return t
    }
  } catch {
    /* no exif */
  }
  return null
}

async function run(id: number): Promise<void> {
  const row = getPhotoRow(id)
  if (!row || row.missing) return
  // 换库检测基准：任务开始时捕获的库代次
  const gen = generation
  try {
    if (!fs.existsSync(row.path)) throw new Error('file missing')
    let input: string | Uint8Array = row.path
    let preview: Buffer | null = null
    let rawFileBuf: Buffer | null = null
    if (isRawExt(row.ext)) {
      // RAW：分档提取嵌入预览（OPT-12）——最大段落盘为查看器预览，中档段（≥128KB 的
      // 最小候选）做缩略图解码源，避免为 512px 缩略图解码全尺寸预览（像素量差数十倍）
      const pair = await extractRawPreviewPair(row.path)
      if (!pair.largest || !pair.largest.length) throw new Error('RAW 文件无可提取的嵌入预览')
      preview = pair.largest
      input = pair.mid && pair.mid.length ? pair.mid : pair.largest
      // EXIF 拍摄时间直接解析已读入内存的 RAW 缓冲，免去对同一文件的二次读盘
      rawFileBuf = pair.fileBuf
    }
    // 同一实例先读头部元数据再生成缩略图，避免重复解析
    const img = sharp(input, { failOn: 'none' })
    const [meta, takenAt] = await Promise.all([
      img.metadata(),
      rawFileBuf ? readTakenAt(rawFileBuf) : readTakenAt(row.path)
    ])
    // 库代次已变（备份导入换库）：本任务基于旧库行，全部写入作废
    if (gen !== generation) return
    if (preview) {
      await writePreviewFile(previewPath(id), preview)
      schedulePreviewBudgetCheck()
    }
    await writeThumbFile(
      thumbPath(id),
      img
        .rotate()
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        // 保留输入 ICC：非 sRGB 素材（Adobe RGB / Display P3 写真常见）丢 profile 后
        // 浏览器按 sRGB 解读，网格缩略图与查看器（media:// 原图，ICC 正确）观感不一致
        .keepIccProfile()
    )
    // 编码期间换库的残余窗口：已写出的错位产物随写随清，不污染新库
    if (gen !== generation) {
      fs.promises.rm(thumbPath(id), { force: true }).catch(() => undefined)
      if (preview) fs.promises.rm(previewPath(id), { force: true }).catch(() => undefined)
      return
    }
    // 入库宽高为显示尺寸：EXIF 方向 5-8 存储时旋转 90°，宽高互换
    // （与缩略图 .rotate() 及查看器的视觉一致，详情面板/导出模板直接可信）
    const swap = (meta.orientation ?? 1) >= 5 && (meta.orientation ?? 1) <= 8
    const w = swap ? (meta.height ?? null) : (meta.width ?? null)
    const h = swap ? (meta.width ?? null) : (meta.height ?? null)
    setPhotoDimsAndDate(id, w, h, takenAt)
    thumbRetries.delete(id)
    setThumbStatus(id, 1)
    enqueuePhash(id)
    emit({ id, status: 'ok' })
  } catch (err) {
    logError('thumb', err)
    // 换库后旧任务的失败不再污染新库的状态位
    if (gen !== generation) return
    // 瞬时失败退避重试；耗尽后进入失败态（emit fail → 网格显示错误占位）
    const attempts = thumbRetries.get(id) ?? 0
    if (attempts < THUMB_RETRY_DELAYS.length) {
      thumbRetries.set(id, attempts + 1)
      setTimeout(() => enqueueThumb(id), THUMB_RETRY_DELAYS[attempts])
      return
    }
    thumbRetries.delete(id)
    setThumbStatus(id, 2)
    emit({ id, status: 'fail' })
  }
}

export async function rebuildAllThumbs(): Promise<void> {
  const ids = listPhotoIdsForRebuild()
  for (const id of ids) {
    setThumbStatus(id, 0)
    enqueueThumb(id)
  }
}

/** 原子写残留临时文件的最低年龄：避开进行中的写入，只清理崩溃残留 */
const TMP_RESIDUE_MIN_AGE_MS = 5 * 60 * 1000

/** 清理索引库中不存在照片的孤儿缩略图文件，返回删除数量 */
export function cleanupOrphanThumbs(): number {
  const ids = new Set(listAllPhotoIds())
  const dir = thumbsDir()
  let removed = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const m = /^(\d+)(?:\.webp|\.preview\.jpg)(\.tmp)?$/.exec(name)
    if (!m) continue
    const p = path.join(dir, name)
    try {
      if (m[2] !== undefined) {
        // 原子写（tmp + rename）崩溃残留：仅清理超过最低年龄的，避开进行中的写入
        const st = fs.statSync(p)
        if (Date.now() - st.mtimeMs < TMP_RESIDUE_MIN_AGE_MS) continue
      } else if (ids.has(Number(m[1]))) {
        continue
      }
      fs.rmSync(p, { force: true })
      removed++
    } catch {
      /* 单个文件删除失败忽略 */
    }
  }
  return removed
}
