/**
 * RAW 全尺寸嵌入预览提取：
 * - 通用扫描文件内最大的完整 JPEG 嵌入段（CR2/NEF 的 JpgFromRaw、ARW/DNG 的 PreviewImage 等
 *   格式各异且 exifr 未提供统一提取 API，字节级扫描为格式无关方案）
 * - 相比仅取 IFD1 缩略图（exifr.thumbnail，部分机型仅 160px 级），查看器画质跨档提升
 * - 扫描不到有效大图时回退 exifr 嵌入缩略图（与旧行为一致）
 * - 大文件读取串行化：thumbs 队列并发最高 6，超大 RAW 并发整读会造成内存尖峰
 *
 * JPEG 结构事实：熵编码段内 FF 会被 0x00 填充转义，真实标记不会出现在数据段中，
 * 故 SOI(FFD8FF)/EOI(FFD9) 字节匹配可靠；预览 EXIF 段内嵌的缩略图 JPEG 通过嵌套跳过处理。
 */
import fs from 'node:fs'
import exifr from 'exifr'

const SOI = Buffer.from([0xff, 0xd8, 0xff])
const EOI = Buffer.from([0xff, 0xd9])
/** 有效预览的最小字节数：过滤填充数据中的伪 SOI/EOI 噪声 */
const MIN_PREVIEW_BYTES = 1024

/** FFD8 后应紧跟 FF + 段标记（APPn/DQT/DHT/SOF/SOS/COM 等），用于过滤伪标记 */
function plausibleJpegStart(buf: Buffer, start: number): boolean {
  const m = buf[start + 3]
  if (m === undefined) return false
  return (
    (m >= 0xc0 && m <= 0xcf) ||
    (m >= 0xe0 && m <= 0xef) ||
    m === 0xdb ||
    m === 0xdd ||
    m === 0xda ||
    m === 0xd9 ||
    m === 0xfe
  )
}

/** 从 SOI 起定位匹配的 EOI 位置（跳过嵌套 JPEG）；未找到返回 -1 */
function findJpegEnd(buf: Buffer, start: number): number {
  let i = start + 3
  for (;;) {
    const eoi = buf.indexOf(EOI, i)
    if (eoi < 0) return -1
    const soi = buf.indexOf(SOI, i)
    if (soi >= 0 && soi < eoi) {
      const nestedEnd = findJpegEnd(buf, soi)
      if (nestedEnd < 0) return -1
      i = nestedEnd + 2
      continue
    }
    return eoi
  }
}

/** 在缓冲中找出最大的完整 JPEG 嵌入段（无有效段时返回 null；返回视图共享原缓冲） */
export function findLargestJpeg(buf: Buffer): Buffer | null {
  let best: Buffer | null = null
  let p = buf.indexOf(SOI)
  while (p >= 0) {
    if (plausibleJpegStart(buf, p)) {
      const e = findJpegEnd(buf, p)
      if (e < 0) break
      if (e + 2 - p >= MIN_PREVIEW_BYTES) {
        const cand = buf.subarray(p, e + 2)
        if (best === null || cand.length > best.length) best = cand
      }
      p = buf.indexOf(SOI, e + 2)
    } else {
      p = buf.indexOf(SOI, p + 1)
    }
  }
  return best
}

/** RAW 提取串行链：上一张读完才开始下一张 */
let extractChain: Promise<void> = Promise.resolve()

/** RAW 预览提取：最大嵌入 JPEG 优先，回退 exifr 嵌入缩略图；两者皆无返回 null */
export async function extractRawPreview(filePath: string): Promise<Buffer | null> {
  const run = extractChain.then(async () => {
    const buf = await fs.promises.readFile(filePath)
    const big = findLargestJpeg(buf)
    if (big) return big
    const small = await exifr.thumbnail(filePath)
    return small && small.length ? Buffer.from(small) : null
  })
  extractChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
