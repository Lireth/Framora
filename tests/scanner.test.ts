import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/db', () => ({
  addFolder: vi.fn(),
  checkpointWalPassive: vi.fn(),
  findDeletedPhotoId: vi.fn(() => null),
  findPhotoByPath: vi.fn(),
  getFolderByPath: vi.fn(),
  getPhotoRow: vi.fn(),
  insertPhoto: vi.fn(() => 10),
  insertPhotosBatch: vi.fn(() => [10]),
  listPhotoRowsByFolder: vi.fn(() => []),
  recomputeSearchText: vi.fn(),
  restoreFolder: vi.fn(),
  updatePhotoFileFields: vi.fn(),
  updatePhotoFilesBatch: vi.fn(),
  updatePhotoPath: vi.fn(),
}))
vi.mock('../src/main/thumbs', () => ({ enqueueThumb: vi.fn() }))

import { IMAGE_EXTS } from '@shared/formats'
import {
  cancelScan,
  importFolder,
  isImagePath,
  splitImportPaths,
  trackChangedFile,
  trackDeletedFile,
  trackNewFile,
} from '../src/main/scanner'
import {
  addFolder,
  findPhotoByPath,
  getFolderByPath,
  getPhotoRow,
  insertPhoto,
  insertPhotosBatch,
  listPhotoRowsByFolder,
  recomputeSearchText,
  restoreFolder,
  updatePhotoFileFields,
  updatePhotoFilesBatch,
  updatePhotoPath,
} from '../src/main/db'
import { enqueueThumb } from '../src/main/thumbs'

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

describe('缺失标记与恢复（O4 双漏洞回归）', () => {
  beforeEach(() => {
    vi.mocked(getFolderByPath).mockReturnValue(undefined)
    vi.mocked(addFolder).mockReturnValue(21)
    vi.mocked(findPhotoByPath).mockReset()
    vi.mocked(updatePhotoFileFields).mockReset()
    vi.mocked(updatePhotoPath).mockReset()
    vi.mocked(updatePhotoFilesBatch).mockReset()
    vi.mocked(insertPhoto).mockReset()
  })

  it('重扫描时目录中已消失的已知文件标记 missing=1，已缺失行不重复标记', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-scan-gone-'))
    // 单次调用生效即可，避免 mock 返回值泄漏到其他 describe 的 importFolder 用例
    vi.mocked(listPhotoRowsByFolder).mockReturnValueOnce([
      { id: 31, path: path.join(dir, 'gone.jpg'), mtime: 1, size: 1, missing: 0 },
      { id: 32, path: path.join(dir, 'still.jpg'), mtime: 1, size: 1, missing: 0 },
      { id: 33, path: path.join(dir, 'gone2.jpg'), mtime: 1, size: 1, missing: 1 },
    ])
    // 磁盘上仅 still.jpg 存在：gone.jpg 在应用关闭期间被删除
    writeFileSync(path.join(dir, 'still.jpg'), 'x')

    const r = await importFolder(dir)
    expect(r.missing).toBe(1)
    const patches = vi.mocked(updatePhotoFilesBatch).mock.calls.flat(2)
    expect(patches).toContainEqual({ id: 31, missing: 1 })
    // 已缺失行（33）不再重复写
    expect(patches).not.toContainEqual(expect.objectContaining({ id: 33 }))
  })

  it('重建的同名文件命中既有行时清除缺失标记并重建缩略图', () => {
    vi.mocked(findPhotoByPath).mockReturnValueOnce({
      id: 44,
      path: 'C:\\pic\\a.jpg',
      missing: 1,
    } as never)
    trackNewFile(1, 'C:\\pic\\a.jpg')
    expect(updatePhotoFileFields).toHaveBeenCalledWith(44, { missing: 0 })
    expect(enqueueThumb).toHaveBeenCalledWith(44)
    expect(insertPhoto).not.toHaveBeenCalled()
  })

  it('大小写变体重建：既刷新路径也清除缺失', () => {
    vi.mocked(findPhotoByPath).mockReturnValueOnce({
      id: 45,
      path: 'C:\\pic\\A.jpg',
      missing: 1,
    } as never)
    trackNewFile(1, 'C:\\pic\\a.jpg')
    expect(updatePhotoPath).toHaveBeenCalledWith(45, 'C:\\pic\\a.jpg', 'a.jpg')
    expect(updatePhotoFileFields).toHaveBeenCalledWith(45, { missing: 0 })
  })

  it('change 事件命中缺失行时一并恢复', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-scan-chg-'))
    const p = path.join(dir, 'b.jpg')
    writeFileSync(p, 'x')
    vi.mocked(findPhotoByPath).mockReturnValueOnce({ id: 46, path: p, missing: 1 } as never)
    trackChangedFile(1, p)
    await new Promise((r) => setTimeout(r, 30))
    expect(updatePhotoFileFields).toHaveBeenCalledWith(46, {
      size: expect.any(Number),
      mtime: expect.any(Number),
      missing: 0,
    })
    expect(enqueueThumb).toHaveBeenCalledWith(46)
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
    expect(r).toEqual({ folderId: 7, found: 1, added: 1, updated: 0, unsupported: 1, missing: 0 })
    const inserted = vi.mocked(insertPhotosBatch).mock.calls[0][0]
    expect(inserted).toHaveLength(1)
    expect(inserted[0].ext).toBe('jpg')
  })

  it('已移除（软删除）的同路径文件夹在重新导入时复活，而不是新建重复根', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-scan-revive-'))
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .jpeg()
      .toFile(path.join(dir, 'a.jpg'))
    vi.mocked(getFolderByPath).mockReturnValue({
      id: 7,
      path: dir,
      name: path.basename(dir),
      added_at: 1,
      count: 0,
      deleted_at: 123,
    })
    vi.mocked(addFolder).mockClear()
    vi.mocked(restoreFolder).mockClear()

    const r = await importFolder(dir)
    expect(r.folderId).toBe(7)
    expect(restoreFolder).toHaveBeenCalledWith(7)
    expect(addFolder).not.toHaveBeenCalled()
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

describe('splitImportPaths 导入路径分流', () => {
  it('图片扩展名直接归入文件，不逐个 stat', async () => {
    const r = await splitImportPaths(['C:/pic/a.jpg', 'C:/pic/b.PNG'])
    expect(r.files).toHaveLength(2)
    expect(r.files).toContain('C:/pic/a.jpg')
    expect(r.files).toContain('C:/pic/b.PNG')
    expect(r.dirs).toEqual([])
    expect(r.skipped).toBe(0)
  })

  it('目录按真实类型归入 dirs（解析为绝对路径）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-split-'))
    const r = await splitImportPaths([dir])
    expect(r.dirs).toHaveLength(1)
    expect(path.resolve(r.dirs[0]).toLowerCase()).toBe(path.resolve(dir).toLowerCase())
  })

  it('不存在的路径计 skipped；重复路径（大小写不敏感）只处理一次', async () => {
    const r = await splitImportPaths(['C:/pic/a.jpg', 'C:/PIC/A.JPG', 'C:/pic/missing-folder'])
    expect(r.files).toEqual(['C:/pic/a.jpg'])
    expect(r.skipped).toBe(1)
  })
})


describe('疑似改名迁移（OPT-39）', () => {
  beforeEach(() => {
    vi.mocked(findPhotoByPath).mockReset()
    vi.mocked(getPhotoRow).mockReset()
    vi.mocked(updatePhotoPath).mockReset()
    vi.mocked(updatePhotoFileFields).mockReset()
    vi.mocked(recomputeSearchText).mockReset()
    vi.mocked(insertPhoto).mockReset()
    vi.mocked(insertPhoto).mockReturnValue(10)
  })

  it('删除后同文件夹出现大小+mtime 相符的新文件：迁移旧行而非新建', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-rename-'))
    const newPath = path.join(dir, 'renamed.jpg')
    writeFileSync(newPath, Buffer.alloc(1234, 1))
    const st = statSync(newPath)
    vi.mocked(findPhotoByPath)
      .mockReturnValueOnce({ id: 42, path: path.join(dir, 'old.jpg') } as never) // trackDeletedFile
      .mockReturnValue(undefined) // trackNewFile 路径未命中
    vi.mocked(getPhotoRow).mockReturnValue({
      id: 42,
      folder_id: 1,
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      missing: 0,
    } as never)
    trackDeletedFile(1, path.join(dir, 'old.jpg'))
    expect(updatePhotoFileFields).toHaveBeenCalledWith(42, { missing: 1 })

    // 资源管理器改名 → 新路径 add 事件（awaitWriteFinish 延迟后到达）
    const r = await trackNewFile(1, newPath)
    expect(r).toBe(false)
    expect(updatePhotoPath).toHaveBeenCalledWith(42, newPath, 'renamed.jpg')
    expect(updatePhotoFileFields).toHaveBeenCalledWith(42, { missing: 0 })
    expect(recomputeSearchText).toHaveBeenCalledWith([42])
    expect(insertPhoto).not.toHaveBeenCalled()
  })

  it('大小不符或文件夹不同：按全新文件入库，不迁移', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-rename-'))
    const other = path.join(dir, 'other.jpg')
    writeFileSync(other, Buffer.alloc(9999, 1))
    vi.mocked(findPhotoByPath).mockReturnValue(undefined)
    vi.mocked(getPhotoRow).mockReturnValue({
      id: 42,
      folder_id: 1,
      size: 1234,
      mtime: 5000,
      missing: 0,
    } as never)
    trackDeletedFile(1, path.join(dir, 'old.jpg'))
    // 尺寸不同 → 不迁移，按新文件入库
    await trackNewFile(1, other)
    expect(updatePhotoPath).not.toHaveBeenCalled()
    expect(insertPhoto).toHaveBeenCalled()
  })
})
