import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/db', () => ({
  addFolder: vi.fn(),
  findDeletedPhotoId: vi.fn(() => null),
  findPhotoByPath: vi.fn(),
  getFolderByPath: vi.fn(),
  insertPhoto: vi.fn(),
  insertPhotosBatch: vi.fn(() => [10]),
  listPhotoRowsByFolder: vi.fn(() => []),
  updatePhotoFileFields: vi.fn(),
  updatePhotoFilesBatch: vi.fn(),
  updatePhotoPath: vi.fn()
}))
vi.mock('../src/main/thumbs', () => ({ enqueueThumb: vi.fn() }))

import { IMAGE_EXTS } from '@shared/formats'
import { cancelScan, importFolder, isImagePath, trackDeletedFile, trackNewFile } from '../src/main/scanner'
import {
  addFolder,
  findPhotoByPath,
  getFolderByPath,
  insertPhoto,
  insertPhotosBatch,
  updatePhotoFileFields,
  updatePhotoPath
} from '../src/main/db'

describe('isImagePath', () => {
  it('识别全部支持的扩展名（大小写不敏感）', () => {
    for (const ext of IMAGE_EXTS) {
      expect(isImagePath(`C:\\pic\\photo.${ext}`)).toBe(true)
      expect(isImagePath(`C:\\pic\\photo.${ext.toUpperCase()}`)).toBe(true)
    }
  })
  it('拒绝非图片扩展名', () => {
    expect(isImagePath('C:\\pic\\notes.txt')).toBe(false)
    expect(isImagePath('C:\\pic\\archive.zip')).toBe(false)
    expect(isImagePath('C:\\pic\\noext')).toBe(false)
  })
})

describe('trackDeletedFile', () => {
  beforeEach(() => {
    vi.mocked(findPhotoByPath).mockReset()
    vi.mocked(updatePhotoFileFields).mockReset()
  })

  it('库内文件被删除时标记 missing=1', () => {
    vi.mocked(findPhotoByPath).mockReturnValue({ id: 42 } as never)
    trackDeletedFile(1, 'C:\\pic\\a.jpg')
    expect(updatePhotoFileFields).toHaveBeenCalledWith(42, { missing: 1 })
  })

  it('库外文件删除不产生任何写操作', () => {
    vi.mocked(findPhotoByPath).mockReturnValue(undefined)
    trackDeletedFile(1, 'C:\\pic\\ghost.jpg')
    expect(updatePhotoFileFields).not.toHaveBeenCalled()
  })
})

describe('trackNewFile 路径大小写归一', () => {
  beforeEach(() => {
    vi.mocked(findPhotoByPath).mockReset()
    vi.mocked(updatePhotoPath).mockReset()
    vi.mocked(insertPhoto).mockReset()
  })

  it('仅改大小写的重命名：刷新既有行为磁盘实际大小写，不产生新行', () => {
    vi.mocked(findPhotoByPath).mockReturnValueOnce({ id: 42, path: 'C:\\pic\\A.JPG' } as never)
    trackNewFile(1, 'C:\\pic\\a.jpg')
    expect(updatePhotoPath).toHaveBeenCalledWith(42, 'C:\\pic\\a.jpg', 'a.jpg')
    expect(insertPhoto).not.toHaveBeenCalled()
  })

  it('路径大小写完全一致时保持原状（不触发无谓重算）', () => {
    vi.mocked(findPhotoByPath).mockReturnValueOnce({ id: 43, path: 'C:\\pic\\a.jpg' } as never)
    trackNewFile(1, 'C:\\pic\\a.jpg')
    expect(updatePhotoPath).not.toHaveBeenCalled()
    expect(insertPhoto).not.toHaveBeenCalled()
  })
})

describe('importFolder 已知不支持格式计数', () => {
  beforeEach(() => {
    vi.mocked(getFolderByPath).mockReturnValue(undefined)
    vi.mocked(addFolder).mockReturnValue(7)
    vi.mocked(insertPhotosBatch).mockClear()
  })

  it('JPG 正常入库，HEIC 计入 unsupported 且不入库', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-scan-'))
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .jpeg()
      .toFile(path.join(dir, 'a.jpg'))
    writeFileSync(path.join(dir, 'b.heic'), 'fake')
    writeFileSync(path.join(dir, 'notes.txt'), 'x')

    const r = await importFolder(dir)
    expect(r).toEqual({ folderId: 7, found: 1, added: 1, updated: 0, unsupported: 1 })
    const inserted = vi.mocked(insertPhotosBatch).mock.calls[0][0]
    expect(inserted).toHaveLength(1)
    expect(inserted[0].ext).toBe('jpg')
  })

  it('取消扫描：不写库，结果标记 cancelled', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-scan-cancel-'))
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .jpeg()
      .toFile(path.join(dir, 'a.jpg'))

    // importFolder 在首个 await 前同步登记取消令牌，随后取消即可确定性命中
    const pending = importFolder(dir)
    cancelScan()
    const r = await pending
    expect(r.cancelled).toBe(true)
    expect(r.found).toBe(0)
    expect(r.added).toBe(0)
    expect(insertPhotosBatch).not.toHaveBeenCalled()
  })

  it('取消只影响当次扫描，后续扫描不受影响', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-scan-resume-'))
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .jpeg()
      .toFile(path.join(dir, 'a.jpg'))

    const first = importFolder(dir)
    cancelScan()
    await first
    const r = await importFolder(dir)
    expect(r.cancelled).toBeUndefined()
    expect(r.added).toBe(1)
  })
})
