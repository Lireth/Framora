/**
 * F4 RAW 支持技术验证（spike）：
 * RAW 文件（CR2/NEF/ARW/DNG 均为 TIFF 系容器）的元数据读取依赖 exifr 的 TIFF IFD 解析能力。
 * 本测试在纯 JS 中构造最小合法 TIFF（IFD0 + Exif 子 IFD + 字符串标签），
 * 验证 exifr 能正确走 IFD 链、解码 ASCII 与日期标签 —— 这是 RAW 元数据管线的基础。
 *
 * 待真实 RAW 样本验证的开放项：嵌入预览像素提取（全尺寸 preview / 缩略图 JPEG 的偏移解析）。
 */
import { describe, expect, it } from 'vitest'
import exifr from 'exifr'
import sharp from 'sharp'
import { extractRawPreviewPair, findLargestJpeg } from '../src/main/rawPreview'

/** 构造最小合法 TIFF：II 字节序，IFD0{Make, Model, ExifIFDPointer} → ExifIFD{DateTimeOriginal} */
function buildTiff(): Uint8Array {
  const enc = new TextEncoder()
  const make = enc.encode('FramoraTest\0')
  const model = enc.encode('TestCam\0')
  const dto = enc.encode('2026:01:02 03:04:05\0')

  const ifd0Off = 8
  const exifOff = ifd0Off + 2 + 3 * 12 + 4
  const makeOff = exifOff + 2 + 1 * 12 + 4
  const modelOff = makeOff + make.length
  const dtoOff = modelOff + model.length
  const total = dtoOff + dto.length

  const buf = new ArrayBuffer(total)
  const v = new DataView(buf)
  v.setUint8(0, 0x49)
  v.setUint8(1, 0x49) // 'II' 小端
  v.setUint16(2, 42, true)
  v.setUint32(4, ifd0Off, true)

  const w = (off: number, tag: number, type: number, count: number, value: number): void => {
    v.setUint16(off, tag, true)
    v.setUint16(off + 2, type, true)
    v.setUint32(off + 4, count, true)
    v.setUint32(off + 8, value, true)
  }

  // IFD0：标签需按升序
  v.setUint16(ifd0Off, 3, true)
  w(ifd0Off + 2, 0x010f, 2, make.length, makeOff) // Make
  w(ifd0Off + 14, 0x0110, 2, model.length, modelOff) // Model
  w(ifd0Off + 26, 0x8769, 4, 1, exifOff) // ExifIFDPointer
  v.setUint32(ifd0Off + 38, 0, true)

  // Exif 子 IFD
  v.setUint16(exifOff, 1, true)
  w(exifOff + 2, 0x9003, 2, dto.length, dtoOff) // DateTimeOriginal
  v.setUint32(exifOff + 14, 0, true)

  const bytes = new Uint8Array(buf)
  bytes.set(make, makeOff)
  bytes.set(model, modelOff)
  bytes.set(dto, dtoOff)
  return bytes
}

describe('RAW spike: exifr 对 TIFF 系容器的解析能力', () => {
  it('解析 IFD0 的 Make/Model 字符串标签', async () => {
    const d = await exifr.parse(buildTiff(), { tiff: true, exif: true, reviveValues: true })
    expect(d?.Make).toBe('FramoraTest')
    expect(d?.Model).toBe('TestCam')
  })

  it('解析 Exif 子 IFD 的 DateTimeOriginal 并还原为 Date', async () => {
    const d = await exifr.parse(buildTiff(), { tiff: true, exif: true, reviveValues: true })
    expect(d?.DateTimeOriginal).toBeInstanceOf(Date)
    const dt = d?.DateTimeOriginal as Date
    expect(dt.getFullYear()).toBe(2026)
    expect(dt.getMonth()).toBe(0)
    expect(dt.getDate()).toBe(2)
    expect(dt.getHours()).toBe(3)
    expect(dt.getMinutes()).toBe(4)
    expect(dt.getSeconds()).toBe(5)
  })

  it('无嵌入缩略图时 thumbnail 优雅返回空值', async () => {
    const thumb = await exifr.thumbnail(buildTiff())
    expect(thumb == null).toBe(true)
  })
})

/** 构造带 IFD1 缩略图与独立大预览的合成 TIFF：II 字节序 */
async function buildTiffWithPreview(): Promise<{ buf: Buffer; thumb: Buffer; preview: Buffer }> {
  const thumb = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } })
    .jpeg({ quality: 30 })
    .toBuffer()
  const preview = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#cc7733' } })
    .jpeg({ quality: 80 })
    .toBuffer()
  expect(preview.length).toBeGreaterThan(thumb.length)

  const ifd0 = 8
  const ifd1 = ifd0 + 2 + 12 + 4 // IFD0: 1 条目
  const thumbOff = ifd1 + 2 + 24 + 4 // IFD1: 2 条目
  const total = thumbOff + thumb.length + preview.length
  const buf = Buffer.alloc(total)
  buf.write('II', 0, 'ascii')
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(ifd0, 4)

  // IFD0：1 条目（ImageWidth），next 指向 IFD1
  buf.writeUInt16LE(1, ifd0)
  buf.writeUInt16LE(0x0100, ifd0 + 2)
  buf.writeUInt16LE(3, ifd0 + 4) // SHORT
  buf.writeUInt32LE(1, ifd0 + 6)
  buf.writeUInt16LE(512, ifd0 + 10)
  buf.writeUInt32LE(ifd1, ifd0 + 14)

  // IFD1：ThumbnailOffset + ThumbnailLength，next = 0
  buf.writeUInt16LE(2, ifd1)
  buf.writeUInt16LE(0x0201, ifd1 + 2)
  buf.writeUInt16LE(4, ifd1 + 4) // LONG
  buf.writeUInt32LE(1, ifd1 + 6)
  buf.writeUInt32LE(thumbOff, ifd1 + 10)
  buf.writeUInt16LE(0x0202, ifd1 + 14)
  buf.writeUInt16LE(4, ifd1 + 16)
  buf.writeUInt32LE(1, ifd1 + 18)
  buf.writeUInt32LE(thumb.length, ifd1 + 22)
  buf.writeUInt32LE(0, ifd1 + 26)

  thumb.copy(buf, thumbOff)
  preview.copy(buf, thumbOff + thumb.length)
  return { buf, thumb, preview }
}

describe('RAW 全尺寸预览扫描（findLargestJpeg）', () => {
  it('多个嵌入 JPEG 时取最大者：全尺寸预览优先于 IFD1 缩略图', async () => {
    const { buf, thumb, preview } = await buildTiffWithPreview()
    // 旧行为对照：exifr.thumbnail 仅返回小缩略图
    const old = await exifr.thumbnail(buf)
    expect(old).toBeDefined()
    expect(old!.length).toBe(thumb.length)
    expect(old!.length).toBeLessThan(preview.length)

    // 新实现取最大嵌入段（即全尺寸预览），且段完整可被 sharp 解码
    const found = findLargestJpeg(buf)
    expect(found).not.toBeNull()
    expect(found!.length).toBe(preview.length)
    const meta = await sharp(found!).metadata()
    expect(meta.width).toBe(512)
  })

  it('跳过预览 EXIF 段内嵌缩略图，取完整外层 JPEG', async () => {
    const inner = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer()
    // 填充使外层超过 MIN_PREVIEW_BYTES 阈值（纯色压缩率极高，需注意合成尺寸）
    const filler = Buffer.alloc(1500, 0x55)
    const pad = Buffer.alloc(200, 0x33)
    const outer = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x00, 0x00]),
      inner,
      filler,
      Buffer.from([0xff, 0xd9])
    ])
    const found = findLargestJpeg(Buffer.concat([pad, outer, pad]))
    expect(found?.length).toBe(outer.length)
    expect(found!.length).toBeGreaterThan(inner.length)
  })

  it('无 JPEG 数据或过小的伪标记段返回 null', () => {
    expect(findLargestJpeg(Buffer.alloc(4096, 0x33))).toBeNull()
    expect(findLargestJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
  })
})

describe('RAW 预览分档提取（extractRawPreviewPair）', () => {
  /** 构造一个字节级合法的 JPEG 段（SOI + APP0 头 + 填充 + EOI），无需真实可解码 */
  function synthSegment(fillBytes: number): Buffer {
    return Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00]), // SOI + APP0 头
      Buffer.alloc(fillBytes, 0x55),
      Buffer.from([0xff, 0xd9])
    ])
  }

  function buildRawWithSegments(...segs: Buffer[]): Buffer {
    const pad = Buffer.alloc(64, 0x33)
    const parts: Buffer[] = [pad]
    for (const s of segs) {
      parts.push(Buffer.from([0x00, 0x00, 0x00, 0x00]), s, pad)
    }
    return Buffer.concat(parts)
  }

  it('分档：最大段给查看器，首个 ≥128KB 的最小段给缩略图', async () => {
    // 需要写入真实文件走文件读取路径
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-rawpair-'))
    const tiny = synthSegment(600) // 600B < MIN_PREVIEW_BYTES，应被忽略
    const small = synthSegment(100 * 1024) // 100KB < 128KB 中档下限，跳过
    const mid = synthSegment(200 * 1024) // 200KB ≥ 128KB → 中档
    const big = synthSegment(400 * 1024) // 400KB → 最大段
    const file = path.join(dir, 'sample.raw')
    writeFileSync(file, buildRawWithSegments(tiny, small, mid, big))
    const pair = await extractRawPreviewPair(file)
    expect(pair.largest!.length).toBe(big.length)
    expect(pair.mid!.length).toBe(mid.length)
    expect(pair.fileBuf).not.toBeNull()
  })

  it('仅有单一候选或候选均不达标时 mid 回退为 largest（共享视图）', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-rawpair-'))
    const only = synthSegment(300 * 1024)
    const file = path.join(dir, 'single.raw')
    writeFileSync(file, buildRawWithSegments(only))
    const pair = await extractRawPreviewPair(file)
    expect(pair.largest!.length).toBe(only.length)
    expect(pair.mid!.length).toBe(only.length)
    expect(pair.mid === pair.largest).toBe(true)
  })

  it('无嵌入 JPEG 且容器不可解析时抛错（由调用方兜底，与旧行为一致）', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-rawpair-'))
    const file = path.join(dir, 'empty.raw')
    writeFileSync(file, Buffer.alloc(4096, 0x33))
    await expect(extractRawPreviewPair(file)).rejects.toThrow()
  })
})
