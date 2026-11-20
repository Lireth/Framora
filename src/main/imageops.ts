import path from 'node:path'
import fs from 'node:fs'
import sharp from 'sharp'
import { getPhotoRow, updatePhotoFileFields, updatePhotoMeta } from './db'
import { backupsDir, enqueueThumb } from './thumbs'
import { broadcastExport } from './scanner'
import { logError } from './log'
import type { ExportOptions } from '@shared/types'

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 应用文件名模板并清理 Windows 非法字符（导出与批量重命名共用） */
export function applyTemplate(
  tpl: string,
  row: { name: string; taken_at: number | null; imported_at: number },
  index: number
): string {
  const base = path.basename(row.name, path.extname(row.name))
  const d = new Date(row.taken_at ?? row.imported_at)
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const out = (tpl || '{name}')
    .replaceAll('{name}', base)
    .replaceAll('{date}', date)
    .replaceAll('{index}', String(index + 1).padStart(3, '0'))
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  return out || 'photo'
}

export async function exportPhotos(
  ids: number[],
  destDir: string,
  opts: ExportOptions
): Promise<{ exported: number; failed: number }> {
  await fs.promises.mkdir(destDir, { recursive: true })
  let exported = 0
  let failed = 0
  const used = new Set<string>()
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const row = getPhotoRow(id)
    if (!row || row.missing || !fs.existsSync(row.path)) {
      failed++
      broadcastExport({ done: i + 1, total: ids.length })
      continue
    }
    try {
      const fmt = opts.format ?? 'original'
      const base = applyTemplate(opts.nameTemplate ?? '{name}', row, i)
      let outPath = ''
      let pipe: sharp.Sharp | null = null
      let ext = row.ext

      const noTransform =
        fmt === 'original' && !opts.maxSide && !row.orientation && !row.flip_h && !row.flip_v
      if (noTransform) {
        ext = row.ext
        ;({ outPath } = pickName(destDir, base, ext, used))
        await fs.promises.copyFile(row.path, outPath)
        used.add(outPath.toLowerCase())
        exported++
        continue
      }

      pipe = sharp(row.path, { failOn: 'none' }).rotate()
      if (row.orientation) pipe = pipe.rotate(row.orientation)
      if (row.flip_h) pipe = pipe.flop()
      if (row.flip_v) pipe = pipe.flip()
      if (opts.maxSide) {
        pipe = pipe.resize(opts.maxSide, opts.maxSide, { fit: 'inside', withoutEnlargement: true })
      }
      if (fmt === 'jpeg') {
        pipe = pipe.jpeg({ quality: clamp(opts.quality ?? 90, 10, 100) })
        ext = 'jpg'
      } else if (fmt === 'webp') {
        pipe = pipe.webp({ quality: clamp(opts.quality ?? 90, 10, 100) })
        ext = 'webp'
      } else if (fmt === 'avif') {
        pipe = pipe.avif({ quality: clamp(opts.quality ?? 90, 10, 100) })
        ext = 'avif'
      } else if (fmt === 'png') {
        pipe = pipe.png()
        ext = 'png'
      } else {
        // original 格式但带变换：按源格式重编码
        if (row.ext === 'jpg' || row.ext === 'jpeg') pipe = pipe.jpeg({ quality: 92 })
        else if (row.ext === 'webp') pipe = pipe.webp({ quality: 90 })
        else if (row.ext === 'png') pipe = pipe.png()
        else pipe = pipe.jpeg({ quality: 92 })
      }
      ;({ outPath } = pickName(destDir, base, ext, used))
      await pipe.toFile(outPath)
      used.add(outPath.toLowerCase())
      exported++
    } catch (err) {
      logError('export', err)
      failed++
    }
    broadcastExport({ done: i + 1, total: ids.length })
  }
  return { exported, failed }
}

export function pickName(
  destDir: string,
  base: string,
  ext: string,
  used: Set<string>
): { outName: string; outPath: string } {
  let outName = `${base}.${ext}`
  let outPath = path.join(destDir, outName)
  let i = 1
  while (used.has(outPath.toLowerCase()) || fs.existsSync(outPath)) {
    outName = `${base}(${i}).${ext}`
    outPath = path.join(destDir, outName)
    i++
    if (i > 999) break
  }
  return { outName, outPath }
}

/* ---------- 基础编辑（写入源文件，先备份） ---------- */

/** 每张照片保留的编辑备份上限，超出自动清理最旧的 */
const BACKUP_KEEP = 5

/** 清理指定照片超出保留数量的旧备份（按时间戳文件名倒序保留最新 N 份） */
async function prunePhotoBackups(id: number): Promise<void> {
  try {
    const prefix = `${id}-`
    const names = (await fs.promises.readdir(backupsDir())).filter((n) => n.startsWith(prefix))
    if (names.length <= BACKUP_KEEP) return
    names.sort((a, b) => b.localeCompare(a))
    for (const n of names.slice(BACKUP_KEEP)) {
      await fs.promises.rm(path.join(backupsDir(), n), { force: true }).catch(() => undefined)
    }
  } catch {
    /* 清理失败不影响保存流程 */
  }
}

/** 清理全部编辑备份（设置页维护入口），返回删除数量 */
export async function clearAllBackups(): Promise<number> {
  let removed = 0
  try {
    const names = await fs.promises.readdir(backupsDir())
    for (const n of names) {
      await fs.promises.rm(path.join(backupsDir(), n), { force: true }).catch(() => undefined)
      removed++
    }
  } catch {
    /* 目录不存在视为无备份 */
  }
  return removed
}

/** 读取 EXIF 自动旋转后的显示像素尺寸（orientation 5-8 时宽高互换） */
async function displayedDims(p: string): Promise<{ w: number; h: number }> {
  const meta = await sharp(p, { failOn: 'none' }).metadata()
  const swap = (meta.orientation ?? 1) >= 5 && (meta.orientation ?? 1) <= 8
  return {
    w: swap ? (meta.height ?? 0) : (meta.width ?? 0),
    h: swap ? (meta.width ?? 0) : (meta.height ?? 0)
  }
}

export async function saveEdits(
  id: number,
  edit: {
    rotateDelta?: number
    flipH?: boolean
    flipV?: boolean
    brightness?: number
    contrast?: number
    saturation?: number
    temperature?: number
    tint?: number
    sharpen?: number
    crop?: { x: number; y: number; w: number; h: number }
  }
): Promise<void> {
  const row = getPhotoRow(id)
  if (!row) throw new Error('照片不存在')
  if (!fs.existsSync(row.path)) throw new Error('源文件已丢失，无法编辑')
  const backupName = `${id}-${Date.now()}${path.extname(row.path)}`
  const backupPath = path.join(backupsDir(), backupName)
  await fs.promises.copyFile(row.path, backupPath)
  void prunePhotoBackups(id)

  const tmp = `${row.path}.framora-tmp${path.extname(row.path)}`
  try {
    let pipe = sharp(row.path, { failOn: 'none' }).rotate()
    if (row.orientation) pipe = pipe.rotate(row.orientation)
    if (row.flip_h) pipe = pipe.flop()
    if (row.flip_v) pipe = pipe.flip()
    if (edit.rotateDelta) pipe = pipe.rotate(edit.rotateDelta)
    if (edit.flipH) pipe = pipe.flop()
    if (edit.flipV) pipe = pipe.flip()
    // 裁剪：归一化区域 × EXIF 旋转后的显示尺寸（裁剪 UI 仅在无旋转/翻转状态下可用）
    if (edit.crop && edit.crop.w > 0.001 && edit.crop.h > 0.001) {
      const dims = await displayedDims(row.path)
      if (dims.w > 0 && dims.h > 0) {
        const left = Math.max(0, Math.min(dims.w - 1, Math.round(edit.crop.x * dims.w)))
        const top = Math.max(0, Math.min(dims.h - 1, Math.round(edit.crop.y * dims.h)))
        const width = Math.max(1, Math.min(dims.w - left, Math.round(edit.crop.w * dims.w)))
        const height = Math.max(1, Math.min(dims.h - top, Math.round(edit.crop.h * dims.h)))
        pipe = pipe.extract({ left, top, width, height })
      }
    }
    const brightness = clamp(1 + (edit.brightness ?? 0) / 100, 0.1, 2)
    const saturation = clamp(1 + (edit.saturation ?? 0) / 100, 0, 3)
    const k = clamp(1 + (edit.contrast ?? 0) / 100, 0.4, 1.8)
    // 色温：暖(+) 红↑蓝↓；色调：品红(+) 绿↓；与对比度合并为逐通道 linear
    const t = clamp(edit.temperature ?? 0, -100, 100) / 100
    const tint = clamp(edit.tint ?? 0, -100, 100) / 100
    const rGain = k * (1 + t * 0.3)
    const gGain = k * (1 - tint * 0.25)
    const bGain = k * (1 - t * 0.3)
    pipe.modulate({ brightness, saturation }).linear(
      [rGain, gGain, bGain],
      [-(k - 1) * 128, -(k - 1) * 128, -(k - 1) * 128]
    )
    if (edit.sharpen && edit.sharpen > 0) {
      pipe.sharpen({ sigma: 0.3 + (clamp(edit.sharpen, 0, 100) / 100) * 1.7 })
    }

    // 保持源格式；PNG 保持无损，JPEG 默认 q92
    if (row.ext === 'jpg' || row.ext === 'jpeg') pipe = pipe.jpeg({ quality: 92 })
    else if (row.ext === 'webp') pipe = pipe.webp({ quality: 90 })
    else if (row.ext === 'png') pipe = pipe.png()
    else pipe = pipe.jpeg({ quality: 92 })

    await pipe.toFile(tmp)
    await fs.promises.rm(row.path, { force: true })
    await fs.promises.rename(tmp, row.path)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }

  const st = await fs.promises.stat(row.path)
  updatePhotoFileFields(id, { size: st.size, mtime: Math.round(st.mtimeMs) })
  updatePhotoMeta(id, { orientation: 0, flip_h: 0, flip_v: 0 })
  enqueueThumb(id)
}

export async function revertEdits(id: number): Promise<void> {
  const row = getPhotoRow(id)
  if (!row) throw new Error('照片不存在')
  const prefix = `${id}-`
  const files = await fs.promises
    .readdir(backupsDir())
    .then((names) => names.filter((n) => n.startsWith(prefix)))
  if (!files.length) throw new Error('没有可恢复的编辑备份')
  files.sort((a, b) => b.localeCompare(a))
  const latest = path.join(backupsDir(), files[0])
  await fs.promises.copyFile(latest, row.path)
  const st = await fs.promises.stat(row.path)
  updatePhotoFileFields(id, { size: st.size, mtime: Math.round(st.mtimeMs), missing: 0 })
  updatePhotoMeta(id, { orientation: 0, flip_h: 0, flip_v: 0 })
  enqueueThumb(id)
}
