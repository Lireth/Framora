import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import sharp from 'sharp'
import exifr from 'exifr'
import { BrowserWindow, app } from 'electron'
import { getPhotoRow, listAllPhotoIds, listPhotoIdsForRebuild, setPhotoDimsAndDate, setThumbStatus } from './db'
import { enqueuePhash } from './phash'
import { logError } from './log'
import type { ThumbEvent } from '@shared/types'

const CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 1))

const queue: number[] = []
const queued = new Set<number>()
let running = 0

export function thumbsDir(): string {
  return path.join(app.getPath('userData'), 'thumbs')
}

export function backupsDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

export function thumbPath(id: number): string {
  return path.join(thumbsDir(), `${id}.webp`)
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
  try {
    if (!fs.existsSync(row.path)) throw new Error('file missing')
    const [meta, takenAt] = await Promise.all([
      sharp(row.path, { failOn: 'none' }).metadata(),
      readTakenAt(row.path)
    ])
    await sharp(row.path, { failOn: 'none' })
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbPath(id))
    setPhotoDimsAndDate(id, meta.width ?? null, meta.height ?? null, takenAt)
    setThumbStatus(id, 1)
    enqueuePhash(id)
    emit({ id, status: 'ok' })
  } catch (err) {
    logError('thumb', err)
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
    const m = /^(\d+)\.webp$/.exec(name)
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
