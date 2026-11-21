import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import sharp from 'sharp'
import exifr from 'exifr'
import { BrowserWindow, app } from 'electron'
import { getPhotoRow, listAllPhotoIds, listPhotoIdsForRebuild, setPhotoDimsAndDate, setThumbStatus } from './db'
import { enqueuePhash } from './phash'
import { logError } from './log'
import { isRawExt } from '@shared/formats'
import { extractRawPreview } from './rawPreview'
import type { ThumbEvent } from '@shared/types'

const CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 1))

const queue: number[] = []
const queued = new Set<number>()
let running = 0

/** 库代次：换库（备份导入）后递增；在途任务按开始时捕获的代次校验，过期写入作废 */
let generation = 0

export function bumpThumbGeneration(): void {
  generation++
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

async function readTakenAt(p: string): Promise<number | null> {
  try {
    const d = await exifr.parse(p, {
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
    if (isRawExt(row.ext)) {
      // RAW：优先提取最大嵌入预览（全尺寸 JPEG），缩略图兜底；先只读后校验，再统一落盘
      preview = await extractRawPreview(row.path)
      if (!preview || !preview.length) throw new Error('RAW 文件无可提取的嵌入预览')
      input = preview
    }
    // 同一实例先读头部元数据再生成缩略图，避免重复解析
    const img = sharp(input, { failOn: 'none' })
    const [meta, takenAt] = await Promise.all([img.metadata(), readTakenAt(row.path)])
    // 库代次已变（备份导入换库）：本任务基于旧库行，全部写入作废
    if (gen !== generation) return
    if (preview) await fs.promises.writeFile(previewPath(id), preview)
    await img
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbPath(id))
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
    const m = /^(\d+)(?:\.webp|\.preview\.jpg)$/.exec(name)
    if (!m || ids.has(Number(m[1]))) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed++
    } catch {
      /* 单个文件删除失败忽略 */
    }
  }
  return removed
}
