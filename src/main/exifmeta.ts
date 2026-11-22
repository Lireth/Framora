/**
 * EXIF 扩展元数据回填队列（FEAT-07/08）：GPS 坐标与相机型号的存量补算。
 * 与 phash 队列同款三件套——FIFO 队列 / 库代次守卫 / 启动续跑；
 * 解析走 exifr（TIFF IFD 级，不解码像素），对 JPEG 与 RAW 均适用。
 * 无 GPS 的照片解析后标记 gps_checked，不会每次启动重复入队。
 */
import fs from 'node:fs'
import exifr from 'exifr'
import { getPhotoRow, listPhotoIdsForGps, markGpsChecked, setPhotoCamera, setPhotoGps } from './db'
import { logError } from './log'

const CONCURRENCY = 2

const queue: number[] = []
const queued = new Set<number>()
let running = 0

/** 库代次：换库（备份导入）后递增，旧库在途任务作废 */
let generation = 0

export function bumpExifMetaGeneration(): void {
  generation++
}

export function enqueueGpsBackfill(id: number): void {
  if (queued.has(id)) return
  queued.add(id)
  queue.push(id)
  pump()
}

/** 清空待处理队列（换库时旧 id 无意义） */
export function clearExifMetaQueue(): number {
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
      .catch((err) => logError('exifMeta', err))
      .finally(() => {
        running--
        pump()
      })
  }
}

async function run(id: number): Promise<void> {
  const row = getPhotoRow(id)
  if (!row || row.missing) return
  const gen = generation
  try {
    if (fs.existsSync(row.path)) {
      const d = await exifr.parse(row.path, {
        tiff: true,
        exif: true,
        gps: true,
        xmp: false,
        icc: false,
        iptc: false,
      })
      if (gen !== generation) return
      if (
        typeof d?.latitude === 'number' &&
        typeof d?.longitude === 'number' &&
        Number.isFinite(d.latitude) &&
        Number.isFinite(d.longitude) &&
        Math.abs(d.latitude) <= 90 &&
        Math.abs(d.longitude) <= 180
      ) {
        setPhotoGps(id, d.latitude, d.longitude)
      }
      const camera = [d?.Make, d?.Model]
        .filter((x): x is string => typeof x === 'string')
        .join(' ')
        .trim()
      if (camera) setPhotoCamera(id, camera)
    }
    // 无论是否解析出坐标都标记已检查：无 GPS 的照片不再重复入队
    if (gen !== generation) return
    markGpsChecked(id)
  } catch (err) {
    logError('exifMeta', err)
  }
}

/** 启动续跑：为未解析过 GPS 的存量照片补算 */
export function resumeExifMetaBackfill(): void {
  for (const id of listPhotoIdsForGps()) enqueueGpsBackfill(id)
}
