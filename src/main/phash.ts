import fs from 'node:fs'
import sharp from 'sharp'
import { getPhotoRow, listPhotosForPhash, markPhashDirty, setPhotoPhash } from './db'
import { thumbPath } from './thumbs'
import { logError } from './log'
import { packDhashBits } from './phashCore'

const CONCURRENCY = 2

const queue: number[] = []
const queued = new Set<number>()
let running = 0

export function enqueuePhash(id: number): void {
  if (queued.has(id)) return
  queued.add(id)
  queue.push(id)
  pump()
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!
    queued.delete(id)
    running++
    run(id)
      .catch((err) => logError('phash', err))
      .finally(() => {
        running--
        pump()
      })
  }
}

/** 计算 64-bit dHash（9×8 灰度水平梯度）：优先用已生成的缩略图（RAW 的唯一像素源，普通格式也省一次全图解码） */
async function run(id: number): Promise<void> {
  const row = getPhotoRow(id)
  if (!row || row.missing) return
  const thumb = thumbPath(id)
  const source = fs.existsSync(thumb) ? thumb : row.path
  if (!fs.existsSync(source)) return
  const { data } = await sharp(source, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { lo, hi } = packDhashBits(data)
  setPhotoPhash(id, lo, hi)
  markPhashDirty()
}

/** 启动时为缺少哈希的存量照片补算 */
export function resumePhash(): void {
  for (const r of listPhotosForPhash()) enqueuePhash(r.id)
}
