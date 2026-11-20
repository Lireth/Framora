import path from 'node:path'
import fs from 'node:fs'
import sharp from 'sharp'
import { getPhotoRow, updatePhotoFileFields, updatePhotoMeta } from './db'
import { backupsDir, enqueueThumb } from './thumbs'
import { broadcastExport } from './scanner'
import type { ExportOptions } from '@shared/types'

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
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
      const base = path.basename(row.name, path.extname(row.name))
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
    } catch {
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

export async function saveEdits(
  id: number,
  edit: {
    rotateDelta?: number
    flipH?: boolean
    flipV?: boolean
    brightness?: number
    contrast?: number
    saturation?: number
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
    const brightness = clamp(1 + (edit.brightness ?? 0) / 100, 0.1, 2)
    const saturation = clamp(1 + (edit.saturation ?? 0) / 100, 0, 3)
    const k = clamp(1 + (edit.contrast ?? 0) / 100, 0.4, 1.8)
    pipe.modulate({ brightness, saturation }).linear(k, -(k - 1) * 128)

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
