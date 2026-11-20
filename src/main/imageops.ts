import path from 'node:path'
import fs from 'node:fs'
import sharp from 'sharp'
import { getPhotoRow, updatePhotoFileFields, updatePhotoMeta } from './db'
import { backupsDir, enqueueThumb, RAW_EXTS } from './thumbs'
import { broadcastExport } from './scanner'
import { logError } from './log'
import type { BackupInfo, ExportOptions } from '@shared/types'

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

interface ExportTask {
  src: string
  outPath: string
  /** 原格式无变换：直接复制，跳过编码管线 */
  noTransform: boolean
  orientation: number
  flipH: boolean
  flipV: boolean
  /** 输出格式（noTransform 时无意义） */
  fmt: string
  srcExt: string
  quality: number
  maxSide?: number
}

/** 导出重编码并发数：与 libvips 内部线程池配合，重叠 I/O 等待 */
const EXPORT_CONCURRENCY = 3

export async function exportPhotos(
  ids: number[],
  destDir: string,
  opts: ExportOptions
): Promise<{ exported: number; failed: number }> {
  await fs.promises.mkdir(destDir, { recursive: true })
  const fmt = opts.format ?? 'original'
  const total = ids.length

  // 1. 顺序预分配输出路径：重名判定依赖会话内 used 集合，保持单线程避免并发撞名
  const tasks: ExportTask[] = []
  const used = new Set<string>()
  let exported = 0
  let failed = 0
  let done = 0
  for (let i = 0; i < ids.length; i++) {
    const row = getPhotoRow(ids[i])
    if (!row || row.missing || !fs.existsSync(row.path)) {
      failed++
      broadcastExport({ done: ++done, total })
      continue
    }
    const base = applyTemplate(opts.nameTemplate ?? '{name}', row, i)
    const noTransform =
      fmt === 'original' && !opts.maxSide && !row.orientation && !row.flip_h && !row.flip_v
    let ext = row.ext
    if (!noTransform) {
      if (fmt === 'jpeg') ext = 'jpg'
      else if (fmt === 'webp') ext = 'webp'
      else if (fmt === 'avif') ext = 'avif'
      else if (fmt === 'png') ext = 'png'
    }
    const { outPath } = pickName(destDir, base, ext, used)
    used.add(outPath.toLowerCase())
    tasks.push({
      src: row.path,
      outPath,
      noTransform,
      orientation: row.orientation,
      flipH: !!row.flip_h,
      flipV: !!row.flip_v,
      fmt,
      srcExt: row.ext,
      quality: opts.quality ?? 90,
      maxSide: opts.maxSide
    })
  }

  // 2. 小并发池执行复制/重编码
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++]
      try {
        if (t.noTransform) {
          await fs.promises.copyFile(t.src, t.outPath)
        } else {
          let pipe = sharp(t.src, { failOn: 'none' }).rotate()
          if (t.orientation) pipe = pipe.rotate(t.orientation)
          if (t.flipH) pipe = pipe.flop()
          if (t.flipV) pipe = pipe.flip()
          if (t.maxSide) {
            pipe = pipe.resize(t.maxSide, t.maxSide, { fit: 'inside', withoutEnlargement: true })
          }
          const q = clamp(t.quality, 10, 100)
          if (t.fmt === 'jpeg') pipe = pipe.jpeg({ quality: q })
          else if (t.fmt === 'webp') pipe = pipe.webp({ quality: q })
          else if (t.fmt === 'avif') pipe = pipe.avif({ quality: q })
          else if (t.fmt === 'png') pipe = pipe.png()
          else if (t.srcExt === 'webp') pipe = pipe.webp({ quality: 90 })
          else if (t.srcExt === 'png') pipe = pipe.png()
          else pipe = pipe.jpeg({ quality: 92 })
          await pipe.toFile(t.outPath)
        }
        exported++
      } catch (err) {
        logError('export', err)
        failed++
      }
      broadcastExport({ done: ++done, total })
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(EXPORT_CONCURRENCY, tasks.length)) }, worker)
  )
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
  if (RAW_EXTS.has(row.ext)) throw new Error('RAW 文件不支持写回编辑，请使用导出转换格式')
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

export async function listBackups(id: number): Promise<BackupInfo[]> {
  const dir = backupsDir()
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out: BackupInfo[] = []
  for (const n of names) {
    const m = /^(\d+)-(\d+)\.[a-z0-9]+$/i.exec(n)
    if (!m || Number(m[1]) !== id) continue
    const st = await fs.promises.stat(path.join(dir, n)).catch(() => null)
    out.push({ name: n, ts: Number(m[2]), size: st?.size ?? 0 })
  }
  out.sort((a, b) => b.ts - a.ts)
  return out
}

/** 恢复编辑：默认最近一份备份，可指定历史备份名（编辑历史面板） */
export async function revertEdits(id: number, backupName?: string): Promise<void> {
  const row = getPhotoRow(id)
  if (!row) throw new Error('照片不存在')
  let latest: string
  if (backupName !== undefined) {
    if (!new RegExp(`^${id}-\\d+\\.[a-z0-9]+$`, 'i').test(backupName)) {
      throw new Error('无效的备份文件名')
    }
    latest = path.join(backupsDir(), backupName)
    if (!fs.existsSync(latest)) throw new Error('备份文件不存在')
  } else {
    const prefix = `${id}-`
    const files = await fs.promises
      .readdir(backupsDir())
      .then((names) => names.filter((n) => n.startsWith(prefix)))
      .catch(() => [] as string[])
    if (!files.length) throw new Error('没有可恢复的编辑备份')
    files.sort((a, b) => b.localeCompare(a))
    latest = path.join(backupsDir(), files[0])
  }
  // 与 saveEdits 相同的 tmp+rm+rename 落盘方式：直接覆盖已存在文件在 Windows 上
  // 可能因目标被占用而报 UNKNOWN
  const tmp = `${row.path}.framora-revert-tmp${path.extname(row.path)}`
  try {
    await fs.promises.copyFile(latest, tmp)
    await fs.promises.rm(row.path, { force: true })
    await fs.promises.rename(tmp, row.path)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  const st = await fs.promises.stat(row.path)
  updatePhotoFileFields(id, { size: st.size, mtime: Math.round(st.mtimeMs), missing: 0 })
  updatePhotoMeta(id, { orientation: 0, flip_h: 0, flip_v: 0 })
  enqueueThumb(id)
}
