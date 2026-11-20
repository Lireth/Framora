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
