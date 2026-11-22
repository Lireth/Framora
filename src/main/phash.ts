import fs from 'node:fs'
import sharp from 'sharp'
import { isRawExt } from '@shared/formats'
import {
  getPhotoRow,
  listPhotosForPhash,
  markPhashDirty,
  setPhotoPhash,
  setPhotoPhashExtra,
} from './db'
import { thumbPath } from './thumbs'
import { logError } from './log'
import { packDhashBits } from './phashCore'

const CONCURRENCY = 2

const queue: number[] = []
const queued = new Set<number>()
let running = 0

/** 库代次：换库（备份导入）后递增，换库前已开始的计算不再写入哈希 */
let generation = 0

export function bumpPhashGeneration(): void {
  generation++
}

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

/**
 * 计算 64-bit dHash（9×8 灰度水平梯度）+ 翻转哈希 + 颜色均值（FEAT-17）：
 * 优先用已生成的缩略图（RAW 的唯一像素源，普通格式也省一次全图解码）；
 * 三个管线都作用在数百像素级小图上，开销可忽略。
 */
async function run(id: number): Promise<void> {
  const row = getPhotoRow(id)
  if (!row || row.missing) return
  // 换库检测基准：任务开始时捕获的库代次
  const gen = generation
  const thumb = thumbPath(id)
  const source = fs.existsSync(thumb) ? thumb : row.path
  if (!fs.existsSync(source)) return
  const base = sharp(source, { failOn: 'none' }).rotate()
  const { data } = await base.clone().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  const flip = await base.clone().flop().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  const mean = await base.clone().resize(1, 1).raw().toBuffer({ resolveWithObject: true })
  // 库代次已变（备份导入换库）：旧任务计算的哈希属于错位行，不再写入
  if (gen !== generation) return
  const { lo, hi } = packDhashBits(data)
  const { lo: flo, hi: fhi } = packDhashBits(flip.data)
  // 1×1 均值：3 通道 RGB 打包为 0xRRGGBB；单通道（灰度源）折叠为灰值
  let cm = 0
  if (mean.info.channels >= 3) {
    cm = ((mean.data[0] << 16) | (mean.data[1] << 8) | mean.data[2]) >>> 0
  } else if (mean.info.channels >= 1) {
    const g = mean.data[0] & 255
    cm = ((g << 16) | (g << 8) | g) >>> 0
  }
  setPhotoPhash(id, lo, hi)
  setPhotoPhashExtra(id, flo, fhi, cm)
  markPhashDirty()
}

/**
 * 启动时为缺少哈希或缺少增强数据（翻转/颜色）的存量照片补算。
 * 无可用像素源的照片跳过（OPT-47）：RAW 无缩略图（预编译 libvips 无法解码 RAW
 * 本体）与缩略图失败态（2）此前每次启动必然重放失败并制造日志噪声；
 * 缩略图完成后经 enqueuePhash 自然进入队列。
 */
export function resumePhash(): void {
  for (const r of listPhotosForPhash()) {
    if (r.thumb_status === 2) continue
    if (isRawExt(r.ext) && !fs.existsSync(thumbPath(r.id))) continue
    enqueuePhash(r.id)
  }
}
