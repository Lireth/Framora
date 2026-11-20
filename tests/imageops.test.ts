import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const rows = new Map<number, Record<string, unknown>>()
const broadcasts: { done: number; total: number }[] = []

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../src/main/db', () => ({
  getPhotoRow: (id: number) => rows.get(id),
  updatePhotoFileFields: vi.fn(),
  updatePhotoMeta: vi.fn()
}))
vi.mock('../src/main/thumbs', () => ({
  backupsDir: () => tmpdir(),
  enqueueThumb: vi.fn(),
  RAW_EXTS: new Set(['cr2', 'cr3', 'nef', 'nrw', 'arw', 'raf', 'dng', 'rw2', 'orf', 'pef'])
}))
vi.mock('../src/main/scanner', () => ({
  broadcastExport: (e: { done: number; total: number }) => broadcasts.push(e)
}))

import { exportPhotos, pickName, saveEdits } from '../src/main/imageops'
import exifr from 'exifr'
import type { ExportOptions } from '@shared/types'

let srcDir: string
let destDir: string

interface RowInit {
  id: number
  file?: string
  ext?: string
  orientation?: number
  flipH?: boolean
  flipV?: boolean
}

function addRow(r: RowInit): void {
  rows.set(r.id, {
    id: r.id,
    path: r.file ? path.join(srcDir, r.file) : path.join(srcDir, `ghost-${r.id}.jpg`),
    name: r.file ?? `ghost-${r.id}.jpg`,
    ext: r.ext ?? 'jpg',
    missing: 0,
    orientation: r.orientation ?? 0,
    flip_h: r.flipH ? 1 : 0,
    flip_v: r.flipV ? 1 : 0,
    taken_at: null,
    imported_at: Date.parse('2026-01-01T00:00:00Z')
  })
}

async function makeJpeg(name: string, w = 40, h = 20): Promise<string> {
  const p = path.join(srcDir, name)
  await sharp({ create: { width: w, height: h, channels: 3, background: '#7fb3d5' } })
    .jpeg()
    .toFile(p)
  return p
}

/** 带测试 EXIF 与 Orientation=6 的源图（竖存横显：像素 20×40，自动转正后 40×20） */
async function makeExifJpeg(name: string): Promise<void> {
  await sharp({ create: { width: 40, height: 20, channels: 3, background: '#7fb3d5' } })
    .rotate(90)
    .withMetadata({ exif: { IFD0: { Make: 'framora-test' } }, orientation: 6 })
    .jpeg()
    .toFile(path.join(srcDir, name))
}

beforeAll(async () => {
  srcDir = mkdtempSync(path.join(tmpdir(), 'framora-exp-src-'))
  destDir = mkdtempSync(path.join(tmpdir(), 'framora-exp-dest-'))
  await makeJpeg('a.jpg')
})

describe('pickName 导出命名防覆盖', () => {
  it('目标目录无同名文件时使用原始名称', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-export-'))
    const r = pickName(dir, 'IMG_1001', 'jpg', new Set())
    expect(r.outName).toBe('IMG_1001.jpg')
  })

  it('磁盘已有同名文件时追加序号', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-export-'))
    writeFileSync(path.join(dir, 'IMG_1001.jpg'), 'x')
    const r = pickName(dir, 'IMG_1001', 'jpg', new Set())
    expect(r.outName).toBe('IMG_1001(1).jpg')
  })

  it('本次导出会话内已使用的名称不重复分配', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-export-'))
    const used = new Set<string>()
    const first = pickName(dir, 'a', 'png', used)
    used.add(first.outPath.toLowerCase())
    const second = pickName(dir, 'a', 'png', used)
    expect(second.outName).toBe('a(1).png')
  })
})

describe('exportPhotos（两阶段并行导出回归）', () => {
  const out = (name: string): string => path.join(destDir, name)

  it('原格式无变换 = 逐字节复制', async () => {
    rows.clear()
    broadcasts.length = 0
    addRow({ id: 1, file: 'a.jpg' })
    const r = await exportPhotos([1], destDir, { format: 'original' } as ExportOptions)
    expect(r).toEqual({ exported: 1, failed: 0 })
    const src = readFileSync(path.join(srcDir, 'a.jpg'))
    expect(readFileSync(out('a.jpg'))).toEqual(src)
  })

  it('重编码 + 长边限制生效', async () => {
    rows.clear()
    addRow({ id: 2, file: 'a.jpg' })
    const dest2 = mkdtempSync(path.join(tmpdir(), 'framora-exp-2-'))
    const r = await exportPhotos([2], dest2, { format: 'jpeg', maxSide: 10, quality: 80 } as ExportOptions)
    expect(r.exported).toBe(1)
    const meta = await sharp(path.join(dest2, 'a.jpg')).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(10)
  })

  it('同会话重名自动追加序号，不覆盖首个输出', async () => {
    rows.clear()
    addRow({ id: 3, file: 'a.jpg' })
    const dest3 = mkdtempSync(path.join(tmpdir(), 'framora-exp-3-'))
    await exportPhotos([3, 3], dest3, { format: 'jpeg' } as ExportOptions)
    const first = readFileSync(path.join(dest3, 'a.jpg'))
    expect(first.length).toBeGreaterThan(0)
    expect(readFileSync(path.join(dest3, 'a(1).jpg')).length).toBeGreaterThan(0)
  })

  it('多任务并行：全部产出、名称唯一、进度单调', async () => {
    rows.clear()
    broadcasts.length = 0
    const ids: number[] = []
    for (let i = 0; i < 6; i++) {
      const fname = `bulk-${i}.jpg`
      await makeJpeg(fname, 30 + i, 20)
      addRow({ id: 100 + i, file: fname })
      ids.push(100 + i)
    }
    const dest4 = mkdtempSync(path.join(tmpdir(), 'framora-exp-4-'))
    const r = await exportPhotos(ids, dest4, {
      format: 'webp',
      nameTemplate: '{index}'
    } as ExportOptions)
    expect(r).toEqual({ exported: 6, failed: 0 })
    const names = ['001', '002', '003', '004', '005', '006'].map((n) => `${n}.webp`)
    for (const n of names) expect(readFileSync(path.join(dest4, n)).length).toBeGreaterThan(0)
    expect(broadcasts).toHaveLength(6)
    expect(broadcasts.map((b) => b.done).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect(broadcasts.every((b) => b.total === 6)).toBe(true)
  })

  it('源文件缺失计入 failed 且仍广播进度', async () => {
    rows.clear()
    broadcasts.length = 0
    addRow({ id: 9, file: undefined })
    const r = await exportPhotos([9], destDir, { format: 'jpeg' } as ExportOptions)
    expect(r).toEqual({ exported: 0, failed: 1 })
    expect(broadcasts).toEqual([{ done: 1, total: 1 }])
  })
})

describe('EXIF 元数据保留（编辑写回 / 导出重编码不丢元数据）', () => {
  it('导出重编码保留 EXIF 且 Orientation 归一为 1', async () => {
    rows.clear()
    broadcasts.length = 0
    await makeExifJpeg('exif-export.jpg')
    addRow({ id: 500, file: 'exif-export.jpg' })
    const dest5 = mkdtempSync(path.join(tmpdir(), 'framora-exp-exif-'))
    const r = await exportPhotos([500], dest5, { format: 'jpeg', maxSide: 100 } as ExportOptions)
    expect(r).toEqual({ exported: 1, failed: 0 })
    const outPath = path.join(dest5, 'exif-export.jpg')
    const meta = await sharp(outPath).metadata()
    expect(meta.orientation).toBe(1)
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(100)
    const exif = await exifr.parse(outPath)
    expect(exif?.Make).toBe('framora-test')
  })

  it('编辑写回保留 EXIF 且像素转正、Orientation 归一', async () => {
    rows.clear()
    await makeExifJpeg('exif-edit.jpg')
    addRow({ id: 501, file: 'exif-edit.jpg' })
    await saveEdits(501, { brightness: 10 })
    const p = path.join(srcDir, 'exif-edit.jpg')
    const meta = await sharp(p).metadata()
    expect(meta.orientation).toBe(1)
    // EXIF 方向 6（竖存横显）经自动转正后回到原始显示尺寸
    expect(meta.width).toBe(40)
    expect(meta.height).toBe(20)
    const exif = await exifr.parse(p)
    expect(exif?.Make).toBe('framora-test')
  })
})
