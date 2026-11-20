import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/db', () => ({
  addFolder: vi.fn(),
  findPhotoByPath: vi.fn(),
  getFolderByPath: vi.fn(),
  insertPhoto: vi.fn(),
  listPhotoRowsByFolder: vi.fn(() => []),
  updatePhotoFileFields: vi.fn()
}))
vi.mock('../src/main/thumbs', () => ({ enqueueThumb: vi.fn() }))

import { IMAGE_EXTS, isImagePath, trackDeletedFile } from '../src/main/scanner'
import { findPhotoByPath, updatePhotoFileFields } from '../src/main/db'

describe('isImagePath', () => {
  it('识别全部支持的扩展名（大小写不敏感）', () => {
    for (const ext of IMAGE_EXTS) {
      expect(isImagePath(`C:\\pic\\photo${ext}`)).toBe(true)
      expect(isImagePath(`C:\\pic\\photo${ext.toUpperCase()}`)).toBe(true)
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
