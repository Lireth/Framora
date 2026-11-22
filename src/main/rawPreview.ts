/**
 * RAW 全尺寸嵌入预览提取：
 * - 通用扫描文件内完整的 JPEG 嵌入段（CR2/NEF 的 JpgFromRaw、ARW/DNG 的 PreviewImage 等
 *   格式各异且 exifr 未提供统一提取 API，字节级扫描为格式无关方案）
 * - 相比仅取 IFD1 缩略图（exifr.thumbnail，部分机型仅 160px 级），查看器画质跨档提升
 * - 预览分档（P1/OPT-12）：最大段用于查看器/导出，≥128KB 的最小段用于缩略图——
 *   512px 缩略图无需解码 8000×5000 级全尺寸预览，解码像素量差 4–100 倍
 * - 扫描不到有效大图时回退 exifr 嵌入缩略图（与旧行为一致）
 * - 大文件读取以 2 路受限并发执行：峰值内存 2×RAW 文件大小可控，
 *   相比旧版全局串行链不再使 thumbs 的 6 并发队列退化为 1
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

/** 中档预览的最小字节数：≥ 此值的候选视为可产出清晰 512px 缩略图的预览；
 *  排除 IFD1 级 160px 缩略图（通常 10–30KB），偏小候选回退用最大段兜底 */
const MID_PREVIEW_MIN_BYTES = 128 * 1024

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

/** 在缓冲中收集全部完整 JPEG 嵌入段，按字节数升序返回（无有效段时返回空数组） */
function collectJpegSegments(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let p = buf.indexOf(SOI)
  while (p >= 0) {
    if (plausibleJpegStart(buf, p)) {
      const e = findJpegEnd(buf, p)
      if (e < 0) break
      if (e + 2 - p >= MIN_PREVIEW_BYTES) out.push(buf.subarray(p, e + 2))
      p = buf.indexOf(SOI, e + 2)
    } else {
      p = buf.indexOf(SOI, p + 1)
    }
  }
  out.sort((a, b) => a.length - b.length)
  return out
}

/** 在缓冲中找出最大的完整 JPEG 嵌入段（无有效段时返回 null；返回视图共享原缓冲） */
export function findLargestJpeg(buf: Buffer): Buffer | null {
  const segs = collectJpegSegments(buf)
  return segs.length ? segs[segs.length - 1] : null
}

/* ---------- 轻量 EXIF 提取（原 thumbs.readExifQuick，OPT-45 迁入） ---------- */

/** 缩略图管线的轻量 EXIF：拍摄时间 + GPS 坐标 + 相机型号（同一解析趟，避免重复读盘） */
export interface ExifQuick {
  takenAt: number | null
  lat: number | null
  lon: number | null
  camera: string | null
}

/** 接受路径或缓冲：RAW 路径传整块文件缓冲（在提取闸内解析后立即释放，OPT-45） */
export async function readQuickExif(src: string | Uint8Array): Promise<ExifQuick> {
  const out: ExifQuick = { takenAt: null, lat: null, lon: null, camera: null }
  try {
    const d = await exifr.parse(src, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: false,
      icc: false,
      iptc: false
    })
    const raw = d?.DateTimeOriginal ?? d?.CreateDate ?? d?.ModifyDate
    if (raw instanceof Date && !isNaN(raw.getTime())) out.takenAt = raw.getTime()
    else if (typeof raw === 'string') {
      const t = Date.parse(raw)
      if (!isNaN(t)) out.takenAt = t
    }
    if (
      typeof d?.latitude === 'number' &&
      typeof d?.longitude === 'number' &&
      Number.isFinite(d.latitude) &&
      Number.isFinite(d.longitude) &&
      Math.abs(d.latitude) <= 90 &&
      Math.abs(d.longitude) <= 180
    ) {
      out.lat = d.latitude
      out.lon = d.longitude
    }
    const camera = [d?.Make, d?.Model]
      .filter((x): x is string => typeof x === 'string')
      .join(' ')
      .trim()
    if (camera) out.camera = camera
  } catch {
    /* no exif */
  }
  return out
}

/* ---------- 提取并发闸（2 路受限并发，槽位直接接力避免计数竞态） ---------- */

const RAW_EXTRACT_CONCURRENCY = 2
let activeExtracts = 0
const extractWaiters: (() => void)[] = []

async function acquireExtractSlot(): Promise<void> {
  if (activeExtracts < RAW_EXTRACT_CONCURRENCY) {
    activeExtracts++
    return
  }
  // 由 release 直接把槽位交接给等待者（不经过计数递减），计数保持守恒
  await new Promise<void>((resolve) => extractWaiters.push(resolve))
}

function releaseExtractSlot(): void {
  const next = extractWaiters.shift()
  if (next) next()
  else activeExtracts--
}

/** RAW 预览分档提取结果 */
export interface RawPreviewPair {
  /** 最大嵌入预览：查看器显示源 / 导出转码源，落盘为 .preview.jpg（独立副本，不引用文件缓冲） */
  largest: Buffer | null
  /** 中档预览：缩略图解码源；无更小候选时与 largest 共享同一副本 */
  mid: Buffer | null
  /** 轻量 EXIF（拍摄时间/GPS/相机）：从完整 RAW 缓冲解析——嵌入预览段未必内嵌 EXIF 块；
   *  解析在提取闸内完成，整块 RAW 缓冲随即释放 */
  exif: ExifQuick
}

/** RAW 文件缓冲读取后立即解析：JPEG 嵌入段是文件缓冲的 subarray 视图，视图会把
 *  整块 RAW（50–200MB）钉在内存直到缩略图编码完成（OPT-45），此处复制脱离父缓冲 */
async function extractPair(filePath: string): Promise<RawPreviewPair> {
  const buf = await fs.promises.readFile(filePath)
  const exif = await readQuickExif(buf)
  const segs = collectJpegSegments(buf)
  if (!segs.length) {
    // 从已读入的缓冲提取 IFD1 缩略图，免去对同一文件的二次读盘；解析失败向上抛
    // （容器完全不可解析时由调用方兜底，与旧行为一致）
    const small = await exifr.thumbnail(buf)
    const smallBuf = small && small.length ? Buffer.from(small) : null
    return { largest: smallBuf, mid: smallBuf, exif }
  }
  const largestSrc = segs[segs.length - 1]
  // 中档 = 升序候选中首个达到中档下限的段；无达标候选（或仅有最大段）时与最大段共享副本
  const midSrc = segs.find((s) => s.length >= MID_PREVIEW_MIN_BYTES) ?? largestSrc
  const largest = Buffer.from(largestSrc)
  const mid = midSrc === largestSrc ? largest : Buffer.from(midSrc)
  return { largest, mid, exif }
}

/** RAW 预览分档提取：最大段 + 中档段 + 轻量 EXIF（整块文件缓冲在返回前释放） */
export async function extractRawPreviewPair(filePath: string): Promise<RawPreviewPair> {
  await acquireExtractSlot()
  try {
    return await extractPair(filePath)
  } finally {
    releaseExtractSlot()
  }
}

/** RAW 预览提取（最大段）：查看器/导出路径用；两者皆无返回 null */
export async function extractRawPreview(filePath: string): Promise<Buffer | null> {
  const pair = await extractRawPreviewPair(filePath)
  return pair.largest
}
