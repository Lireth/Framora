/**
 * RAW 预览按需重建：预算淘汰预览后，thumb:// 协议首次请求应能从 RAW 嵌入 JPEG 即时重建。
 * 用合成的"RAW 容器 + 嵌入 JPEG"验证提取与落盘，不依赖真实相机样张。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBoxSync: () => 0 },
}))

// 预览服务只依赖"写完后触发预算检查"；测试中移除定时器，并保留与生产一致的落盘实现
vi.mock('../src/main/thumbs', async () => {
  const { promises } = await import('node:fs')
  return {
    schedulePreviewBudgetCheck: vi.fn(),
    // 库代次恒为 0：测试中不换库，代次校验恒通过
    currentThumbGeneration: () => 0,
    writePreviewFile: async (target: string, buf: Buffer): Promise<void> => {
      await promises.writeFile(target, buf)
    },
  }
})

import * as db from '../src/main/db'
import {
  ensurePreview,
  isPreviewFileName,
  previewIdFromName,
} from '../src/main/previewService'

beforeEach(async () => {
  userData = mkdtempSync(path.join(tmpdir(), 'framora-preview-test-'))
  await db.initDb()
})

afterEach(() => {
  db.closeDb()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* Windows 句柄延迟释放，留给临时目录自清理 */
  }
})

function insert(folderId: number, filePath: string, ext: string): number {
  return db.insertPhoto({
    folder_id: folderId,
    path: filePath,
    name: path.basename(filePath),
    ext,
    size: 1024,
    mtime: 1,
    imported_at: Date.now(),
  })
}

describe('预览文件名解析', () => {
  it('识别预览名并解析 id，拒绝其他扩展名', () => {
    expect(isPreviewFileName('12.preview.jpg')).toBe(true)
    expect(previewIdFromName('12.preview.jpg')).toBe(12)
    expect(previewIdFromName('12.webp')).toBeNull()
    expect(previewIdFromName('x.preview.jpg')).toBeNull()
    expect(previewIdFromName('0.preview.jpg')).toBeNull()
  })
})

describe('ensurePreview', () => {
  it('RAW 预览缺失时从嵌入 JPEG 重建，产物可被 sharp 解码', async () => {
    const folder = db.addFolder('C:\\pics', 'pics')
    const jpeg = await sharp({
      create: { width: 512, height: 512, channels: 3, background: '#cc7733' },
    })
      .jpeg({ quality: 80 })
      .toBuffer()
    // findLargestJpeg 会过滤 < 1KB 的伪标记/极小段，测试样本需高于阈值
    expect(jpeg.length).toBeGreaterThan(1024)
    const rawPath = path.join(userData, 'sample.dng')
    writeFileSync(
      rawPath,
      Buffer.concat([Buffer.alloc(128, 0x11), jpeg, Buffer.alloc(128, 0x22)])
    )
    const id = insert(folder, rawPath, 'dng')
    const target = path.join(userData, 'thumbs', `${id}.preview.jpg`)
    expect(existsSync(target)).toBe(false)

    await ensurePreview(id, target)
    expect(existsSync(target)).toBe(true)
    const meta = await sharp(target).metadata()
    expect(meta.width).toBe(512)
    expect(meta.height).toBe(512)
  })

  it('非 RAW 照片不生成预览文件', async () => {
    const folder = db.addFolder('C:\\pics', 'pics')
    const jpg = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#336699' },
    })
      .jpeg()
      .toBuffer()
    const p = path.join(userData, 'plain.jpg')
    writeFileSync(p, jpg)
    const id = insert(folder, p, 'jpg')
    const target = path.join(userData, 'thumbs', `${id}.preview.jpg`)

    await ensurePreview(id, target)
    expect(existsSync(target)).toBe(false)
  })

  it('源文件丢失时静默返回，不产生半成品', async () => {
    const folder = db.addFolder('C:\\pics', 'pics')
    const id = insert(folder, path.join(userData, 'gone.dng'), 'dng')
    const target = path.join(userData, 'thumbs', `${id}.preview.jpg`)

    await ensurePreview(id, target)
    expect(existsSync(target)).toBe(false)
  })
})
