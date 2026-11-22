import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { getPhotoRow, getSetting, listPhotoRowsByIds, updatePhotoFileFields, updatePhotoMeta } from './db'
import { backupsDir, enqueueThumb, previewPath } from './thumbs'
import { extractRawPreview } from './rawPreview'
import { broadcastExport } from './scanner'
import { logError } from './log'
import { IO_CONCURRENCY, assertFreeSpace, mapLimited } from './disk'
import { isRawExt } from '@shared/formats'
import type {
  BackupInfo,
  CleanupResult,
  EditAdjustments,
  ExportOptions,
  ExportResult,
  WatermarkOptions,
} from '@shared/types'

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
  /** RAW 转码源对应的原始 RAW 文件路径：预览缓存缺失时按需提取嵌入预览 */
  rawSource?: string
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
  adjust?: EditAdjustments
  watermark?: WatermarkOptions
  /** 中心裁剪宽高比（FEAT-22）：作用于旋转/翻转后的视觉空间 */
  cropAspect?: number
}

/** 导出重编码并发数：与 libvips 内部线程池配合，重叠 I/O 等待 */
const EXPORT_CONCURRENCY = 3

/** 进行中的导出任务（取消标记）：photos:cancelExport 使全部在途导出尽快中止 */
const activeExports = new Set<{ cancelled: boolean }>()

export function cancelExport(): void {
  for (const t of activeExports) t.cancelled = true
}

export async function exportPhotos(
  ids: number[],
  destDir: string,
  opts: ExportOptions
): Promise<ExportResult> {
  // 令牌在任何 await 之前登记，保证调用方同步调用 cancelExport 即可取消本次导出
  const token = { cancelled: false }
  activeExports.add(token)
  try {
    await fs.promises.mkdir(destDir, { recursive: true })
    const fmt = opts.format ?? 'original'
    const total = ids.length

    // 1. 批量取行 + 有界并发探测源文件存在性（OPT-46）：此前预分配在主进程同步
    //    执行万级点查 + 万级 existsSync，千级导出即阻塞主进程数百毫秒
    const rowsById = new Map(listPhotoRowsByIds(ids).map((r) => [r.id, r]))
    const exists = await mapLimited(ids, IO_CONCURRENCY, async (id) => {
      const row = rowsById.get(id)
      if (!row) return false
      return fs.promises.access(row.path).then(
        () => true,
        () => false
      )
    })
    // 2. 顺序预分配输出路径：重名判定依赖会话内 used 集合，保持单线程避免并发撞名
    const tasks: ExportTask[] = []
    const used = new Set<string>()
    let exported = 0
    let failed = 0
    let done = 0
    for (let i = 0; i < ids.length; i++) {
      if (token.cancelled) break
      const row = rowsById.get(ids[i])
      if (!row || row.missing || !exists[i]) {
        failed++
        done++
        // 进度节流：每 25 张或最后一张推送一次（千张导出不再逐张触发渲染端 set）
        if (done % 25 === 0 || done === total) broadcastExport({ done, total })
        continue
      }
      const base = applyTemplate(opts.nameTemplate ?? '{name}', row, i)
      // 有调整/水印/裁剪时 original 格式也必须走重编码管线（否则变换被静默跳过）
      const noTransform =
        fmt === 'original' &&
        !opts.maxSide &&
        !row.orientation &&
        !row.flip_h &&
        !row.flip_v &&
        !opts.adjust &&
        !opts.watermark &&
        !opts.cropAspect
      // sharp 预编译 libvips 不含 libraw，无法解码 RAW 本体；需转码时改用嵌入预览（JPEG）作为源
      const rawPreviewSrc = !noTransform && isRawExt(row.ext)
      let ext = row.ext
      if (!noTransform) {
        if (fmt === 'jpeg') ext = 'jpg'
        else if (fmt === 'webp') ext = 'webp'
        else if (fmt === 'avif') ext = 'avif'
        else if (fmt === 'png') ext = 'png'
        // original 保持 RAW 扩展名会产出 JPEG 内容配 RAW 扩展名的文件，统一落为 jpg
        else if (rawPreviewSrc) ext = 'jpg'
        // original 保持 GIF/BMP 扩展名会产出重编码内容配原扩展名的文件：
        // 重编码管线不支持回写这两种格式，统一落为 PNG（导出是副本，不涉及写回守卫）
        else if (row.ext === 'gif' || row.ext === 'bmp') ext = 'png'
      }
      const { outPath } = pickName(destDir, base, ext, used)
      used.add(outPath.toLowerCase())
      tasks.push({
        src: rawPreviewSrc ? previewPath(row.id) : row.path,
        rawSource: rawPreviewSrc ? row.path : undefined,
        outPath,
        noTransform,
        orientation: row.orientation,
        flipH: !!row.flip_h,
        flipV: !!row.flip_v,
        fmt,
        srcExt: row.ext,
        quality: opts.quality ?? 90,
        maxSide: opts.maxSide,
        adjust: opts.adjust,
        watermark: opts.watermark,
        cropAspect: opts.cropAspect
      })
    }

    // 3. 小并发池执行复制/重编码
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < tasks.length && !token.cancelled) {
        const t = tasks[cursor++]
        try {
          if (t.noTransform) {
            await fs.promises.copyFile(t.src, t.outPath)
          } else {
            // RAW 转码源为嵌入预览；缓存缺失（旧索引导入/清理过 thumbs）时按需提取：
            // 直接以缓冲转码不依赖落盘，回填缓存尽力而为（供查看器后续复用）
            let srcInput: string | Buffer = t.src
            if (t.rawSource && !fs.existsSync(t.src)) {
              const preview = await extractRawPreview(t.rawSource)
              if (!preview || !preview.length) throw new Error('RAW 文件无可提取的嵌入预览')
              srcInput = preview
              await fs.promises.writeFile(t.src, preview).catch(() => undefined)
            }
            // withMetadata 保留 EXIF/ICC 等元数据；像素已按 EXIF/应用方向烘焙为正立，
            // Orientation 必须显式重写为 1，避免其他软件按旧方向二次旋转
            let pipe = sharp(srcInput, { failOn: 'none' }).rotate().withMetadata({ orientation: 1 })
            if (t.orientation) pipe = pipe.rotate(t.orientation)
            if (t.flipH) pipe = pipe.flop()
            if (t.flipV) pipe = pipe.flip()
            // 中心裁剪到目标宽高比（FEAT-22）：extract 在 rotate/flip 之后调用，
            // 作用于视觉空间（sharp 的 post-extract）；中心裁剪对翻转对称，
            // 尺寸按「EXIF 转正 + 用户旋转」后的最终画布计算
            if (t.cropAspect && t.cropAspect > 0) {
              const visual = await visualDims(srcInput, t.orientation)
              const box = centerCropBox(visual.w, visual.h, t.cropAspect)
              if (box) pipe = pipe.extract(box)
            }
            if (t.maxSide) {
              pipe = pipe.resize(t.maxSide, t.maxSide, { fit: 'inside', withoutEnlargement: true })
            }
            // 编辑预设调整（FEAT-10）：与查看器保存同一套算子
            if (t.adjust) applyAdjustments(pipe, t.adjust)
            // 文字水印（FEAT-11）：管线末端合成（重力作用于缩放后的最终画布）
            if (t.watermark) {
              const out = await estimateOutDims(srcInput, t.orientation, t.maxSide)
              const overlay = await watermarkSvg(t.watermark, out)
              const gravity = watermarkGravity(t.watermark.position)
              pipe = pipe.composite([{ input: overlay, ...(gravity ? { gravity } : {}) }])
            }
            const q = clamp(t.quality, 10, 100)
            if (t.fmt === 'jpeg') pipe = pipe.jpeg({ quality: q })
            else if (t.fmt === 'webp') pipe = pipe.webp({ quality: q })
            else if (t.fmt === 'avif') pipe = pipe.avif({ quality: q })
            else if (t.fmt === 'png') pipe = pipe.png()
            else if (t.srcExt === 'webp') pipe = pipe.webp({ quality: 90 })
            else if (t.srcExt === 'png') pipe = pipe.png()
            // 与上方 ext 映射配套：GIF/BMP 落 PNG、TIFF 保持 TIFF，避免内容与扩展名不符
            else if (t.srcExt === 'gif' || t.srcExt === 'bmp') pipe = pipe.png()
            else if (t.srcExt === 'tif' || t.srcExt === 'tiff') pipe = pipe.tiff()
            else pipe = pipe.jpeg({ quality: 92 })
            await pipe.toFile(t.outPath)
          }
          exported++
        } catch (err) {
          logError('export', err)
          failed++
        }
        done++
        // 进度节流：每 25 张或最后一张推送一次
        if (done % 25 === 0 || done === total) broadcastExport({ done, total })
      }
    }
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(EXPORT_CONCURRENCY, tasks.length)) }, worker)
    )
    if (token.cancelled) broadcastExport({ done, total })
    return token.cancelled ? { exported, failed, cancelled: true } : { exported, failed }
  } finally {
    activeExports.delete(token)
  }
}

/**
 * 调整算子（FEAT-10 自 saveEdits 抽取）：亮度/饱和度 modulate + 色温色调对比度
 * 逐通道 linear + 锐化。saveEdits 与导出/转换管线共用，保证预设与单张编辑观感一致。
 */
function applyAdjustments(pipe: sharp.Sharp, a: EditAdjustments): void {
  const brightness = clamp(1 + (a.brightness ?? 0) / 100, 0.1, 2)
  const saturation = clamp(1 + (a.saturation ?? 0) / 100, 0, 3)
  const k = clamp(1 + (a.contrast ?? 0) / 100, 0.4, 1.8)
  // 色温：暖(+) 红↑蓝↓；色调：品红(+) 绿↓；与对比度合并为逐通道 linear
  const t = clamp(a.temperature ?? 0, -100, 100) / 100
  const tint = clamp(a.tint ?? 0, -100, 100) / 100
  const rGain = k * (1 + t * 0.3)
  const gGain = k * (1 - tint * 0.25)
  const bGain = k * (1 - t * 0.3)
  pipe.modulate({ brightness, saturation }).linear(
    [rGain, gGain, bGain],
    [-(k - 1) * 128, -(k - 1) * 128, -(k - 1) * 128]
  )
  if (a.sharpen && a.sharpen > 0) {
    pipe.sharpen({ sigma: 0.3 + (clamp(a.sharpen, 0, 100) / 100) * 1.7 })
  }
}

/** XML 转义（水印文本进 SVG） */
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** 视觉尺寸（FEAT-22）：EXIF 转正 + 应用旋转后的宽高（翻转不改变尺寸） */
async function visualDims(
  srcInput: string | Buffer,
  orientation: number
): Promise<{ w: number; h: number }> {
  const meta = await sharp(srcInput, { failOn: 'none' }).metadata()
  let w = meta.width ?? 0
  let h = meta.height ?? 0
  if ((meta.orientation ?? 1) >= 5 && (meta.orientation ?? 1) <= 8) [w, h] = [h, w]
  if (orientation === 90 || orientation === 270) [w, h] = [h, w]
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

/** 中心裁剪框（FEAT-22）：把 w×h 画面裁到目标宽高比，返回 sharp post-extract 参数；
 *  尺寸不足或比例相同（差异 < 1px）时返回 null 跳过裁剪 */
function centerCropBox(
  w: number,
  h: number,
  aspect: number
): { left: number; top: number; width: number; height: number } | null {
  if (!Number.isFinite(aspect) || aspect <= 0 || w < 2 || h < 2) return null
  const cropW = Math.min(w, Math.floor(h * aspect))
  const cropH = Math.min(h, Math.floor(cropW / aspect))
  if (cropW < 1 || cropH < 1) return null
  if (cropW === w && cropH === h) return null
  return {
    left: Math.floor((w - cropW) / 2),
    top: Math.floor((h - cropH) / 2),
    width: cropW,
    height: cropH
  }
}

/** 输出画布尺寸估算：EXIF 旋转 → 应用旋转 → maxSide 缩放（与导出管线变换序一致） */
async function estimateOutDims(
  srcInput: string | Buffer,
  orientation: number,
  maxSide?: number
): Promise<{ w: number; h: number }> {
  const meta = await sharp(srcInput, { failOn: 'none' }).metadata()
  let w = meta.width ?? 0
  let h = meta.height ?? 0
  if ((meta.orientation ?? 1) >= 5 && (meta.orientation ?? 1) <= 8) [w, h] = [h, w]
  if (orientation === 90 || orientation === 270) [w, h] = [h, w]
  if (maxSide && Math.max(w, h) > maxSide) {
    const k = maxSide / Math.max(w, h)
    w = Math.max(1, Math.round(w * k))
    h = Math.max(1, Math.round(h * k))
  }
  return { w: Math.max(1, w), h: Math.max(1, h) }
}

/**
 * 文字水印 SVG（FEAT-11）：白色文字 + 半透明黑描边保证浅底可读；
 * position/tile 两种布局。composite 在 sharp 管线末端执行，
 * 重力定位作用于最终画布（含缩放后的尺寸）。
 */
async function watermarkSvg(
  wm: WatermarkOptions,
  out: { w: number; h: number }
): Promise<Buffer> {
  const fsz = Math.max(8, Math.min(400, Math.round(wm.fontSize)))
  const text = escapeXml(wm.text.slice(0, 60)) || 'Framora'
  const opacity = clamp(wm.opacity, 1, 100) / 100
  const stroke = Math.max(1, Math.round(fsz / 22))
  const textAttrs = `font-family="sans-serif" font-size="${fsz}" font-weight="600" fill="#ffffff" fill-opacity="${opacity}" stroke="#000000" stroke-opacity="${opacity * 0.55}" stroke-width="${stroke}" paint-order="stroke"`
  // 估算文字宽度：CJK 字符≈1em，其余≈0.55em
  let textW = 0
  for (const ch of wm.text.slice(0, 60)) textW += ch.charCodeAt(0) > 0x2e7f ? fsz : fsz * 0.55
  textW = Math.max(fsz, Math.round(textW)) + stroke * 2
  const textH = Math.round(fsz * 1.3)
  if (wm.position === 'tile') {
    const stepX = Math.max(textW + fsz * 2, 1)
    const stepY = Math.max(textH + fsz * 2.5, 1)
    const parts: string[] = []
    for (let y = out.h * 0.1; y < out.h + stepY; y += stepY) {
      for (let x = -textW; x < out.w + stepX; x += stepX) {
        parts.push(
          `<text x="${Math.round(x)}" y="${Math.round(y)}" ${textAttrs} transform="rotate(-30 ${Math.round(x)} ${Math.round(y)})">${text}</text>`
        )
      }
    }
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${out.w}" height="${out.h}">${parts.join('')}</svg>`
    )
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${textW}" height="${textH}"><text x="${stroke}" y="${Math.round(textH * 0.78)}" ${textAttrs}>${text}</text></svg>`
  return Buffer.from(svg)
}

function watermarkGravity(
  position: WatermarkOptions['position']
): 'northwest' | 'northeast' | 'southwest' | 'southeast' | 'centre' | undefined {
  switch (position) {
    case 'tl': return 'northwest'
    case 'tr': return 'northeast'
    case 'bl': return 'southwest'
    case 'br': return 'southeast'
    case 'center': return 'centre'
    default: return undefined // tile：SVG 自带全幅尺寸，无重力
  }
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
    if (i <= 999) {
      outName = `${base}(${i}).${ext}`
    } else {
      // 超出编号上限：改用时间戳后缀继续避让。原实现在此处 break 返回已存在的
      // outPath，后续 copyFile/toFile 默认覆盖目标——会静默覆盖用户目录里的
      // 同名无关文件，违背「重名自动改名不覆盖」承诺
      outName = `${base}-${Date.now()}-${i - 999}.${ext}`
    }
    outPath = path.join(destDir, outName)
    i++
  }
  return { outName, outPath }
}

/* ---------- 基础编辑（写入源文件，先备份） ---------- */

/** 每张照片保留的编辑备份上限，超出自动清理最旧的 */
const BACKUP_KEEP = 5

/**
 * 编辑备份的身份绑定（O3）：文件名内嵌路径小写归一后的短哈希——换库（备份导入）后
 * id 与照片错位时哈希不再匹配，旧备份不对外提供/恢复；大小写变体重命名哈希不变，
 * 应用内批量重命名经 rekeyEditBackups 重绑定，历史保持可恢复。
 */
function pathHash(p: string): string {
  return createHash('sha256').update(p.toLowerCase()).digest('hex').slice(0, 8)
}

/** 备份文件名（新）：{id}-{pathHash}-{ts}.{ext}，ext 含点 */
function backupNameOf(id: number, p: string, ts: number, ext: string): string {
  return `${id}-${pathHash(p)}-${ts}${ext}`
}

/** 备份文件名解析（按 id）：捕获组 1=路径哈希 2=时间戳 3=扩展名 */
function backupNameRe(id: number): RegExp {
  return new RegExp(`^${id}-([0-9a-f]{8})-(\\d+)\\.([a-z0-9]+)$`, 'i')
}

/** 清理指定照片超出保留数量的旧备份（按时间戳数值倒序保留最新 N 份） */
async function prunePhotoBackups(id: number): Promise<void> {
  try {
    const names = (await fs.promises.readdir(backupsDir())).filter((n) =>
      backupNameRe(id).test(n)
    )
    if (names.length <= BACKUP_KEEP) return
    const tsOf = (n: string): number => Number(backupNameRe(id).exec(n)?.[2] ?? 0)
    names.sort((a, b) => tsOf(b) - tsOf(a))
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

/** 彻底删除后同步清理该照片的全部编辑备份（按 id 前缀匹配新旧两种命名） */
export async function removePhotoBackups(id: number): Promise<void> {
  let names: string[]
  try {
    names = await fs.promises.readdir(backupsDir())
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((n) => backupNameRe(id).test(n) || LEGACY_BACKUP_NAME_RE.test(n))
      .map((n) => fs.promises.rm(path.join(backupsDir(), n), { force: true }).catch(() => undefined)),
  )
}

/**
 * 清理无主编辑备份（OPT-21）：照片行已不存在的 id 组（删除照片/清空回收站/
 * 换库遗留）。预算清理只裁剪历史、每组保底一份，孤儿组因此只增不减且对用户
 * 不可见——此入口让 backups 目录可收敛。
 */
export function cleanupOrphanBackups(): number {
  let names: string[]
  try {
    names = fs.readdirSync(backupsDir())
  } catch {
    return 0
  }
  let removed = 0
  const existsCache = new Map<number, boolean>()
  for (const n of names) {
    const m = BACKUP_NAME_RE.exec(n) ?? LEGACY_BACKUP_NAME_RE.exec(n)
    if (!m) continue
    const id = Number(m[1])
    let exists = existsCache.get(id)
    if (exists === undefined) {
      exists = getPhotoRow(id) !== undefined
      existsCache.set(id, exists)
    }
    if (exists) continue
    try {
      fs.rmSync(path.join(backupsDir(), n), { force: true })
      removed++
    } catch {
      /* 单个文件删除失败忽略 */
    }
  }
  return removed
}

/* ---------- 编辑备份预算 ---------- */

const BACKUP_BUDGET_KEY = 'backupBudgetMb'
/** 默认 4 GB：足够容纳大量单次编辑备份；超限时优先删除较早的历史版本 */
export const DEFAULT_BACKUP_BUDGET_MB = 4096

const BACKUP_NAME_RE = /^(\d+)-([0-9a-f]{8})-(\d+)\.([a-z0-9]+)$/i
const LEGACY_BACKUP_NAME_RE = /^(\d+)-(\d+)\.([a-z0-9]+)$/i

interface BackupEntry {
  name: string
  path: string
  size: number
  mtimeMs: number
  /** 同一照片 + 路径哈希为一组：组内至少保留最新一份 */
  group: string
  ts: number
}

async function readBackupEntries(): Promise<BackupEntry[]> {
  const dir = backupsDir()
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out: BackupEntry[] = []
  await Promise.all(
    names.map(async (name) => {
      const p = path.join(dir, name)
      try {
        const st = await fs.promises.stat(p)
        if (!st.isFile()) return
        const modern = BACKUP_NAME_RE.exec(name)
        const legacy = LEGACY_BACKUP_NAME_RE.exec(name)
        const id = modern ? Number(modern[1]) : legacy ? Number(legacy[1]) : null
        const hash = modern ? modern[2].toLowerCase() : 'legacy'
        const ts = modern ? Number(modern[3]) : legacy ? Number(legacy[2]) : st.mtimeMs
        out.push({
          name,
          path: p,
          size: st.size,
          mtimeMs: st.mtimeMs,
          group: id === null ? name : `${id}-${hash}`,
          ts,
        })
      } catch {
        /* 单文件不可读忽略 */
      }
    }),
  )
  return out
}

/** 编辑备份占用（含历史版本） */
export async function backupStats(): Promise<{ bytes: number; files: number }> {
  const entries = await readBackupEntries()
  return {
    bytes: entries.reduce((n, e) => n + e.size, 0),
    files: entries.length,
  }
}

export function backupBudgetMb(): number {
  try {
    const raw = getSetting(BACKUP_BUDGET_KEY)
    if (raw === null || raw === '') return DEFAULT_BACKUP_BUDGET_MB
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_BACKUP_BUDGET_MB
  } catch {
    return DEFAULT_BACKUP_BUDGET_MB
  }
}

/**
 * 按总预算清理备份历史：每组（照片 + 路径哈希）保留最新一份，
 * 其余按时间从旧到新删除，直到低于预算。预算为 0 时不限制。
 * 即使"最新一份"总量已超预算，也不会继续删除——保证每张编辑过的照片仍可撤销。
 */
export async function enforceBackupBudget(): Promise<CleanupResult> {
  const budget = backupBudgetMb() * 1024 * 1024
  if (!budget) return { deleted: 0, bytes: 0 }
  const entries = await readBackupEntries()
  if (!entries.length) return { deleted: 0, bytes: 0 }
  let total = entries.reduce((n, e) => n + e.size, 0)
  if (total <= budget) return { deleted: 0, bytes: 0 }

  const newest = new Map<string, BackupEntry>()
  for (const e of entries) {
    const cur = newest.get(e.group)
    if (!cur || e.ts > cur.ts || (e.ts === cur.ts && e.mtimeMs > cur.mtimeMs)) {
      newest.set(e.group, e)
    }
  }
  const keep = new Set([...newest.values()].map((e) => e.name))
  const candidates = entries
    .filter((e) => !keep.has(e.name))
    .sort((a, b) => a.ts - b.ts || a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))

  let deleted = 0
  let bytes = 0
  for (const e of candidates) {
    if (total <= budget) break
    try {
      await fs.promises.rm(e.path, { force: true })
      total -= e.size
      bytes += e.size
      deleted++
    } catch {
      /* 被占用或已删除：跳过 */
    }
  }
  return { deleted, bytes }
}

let backupBudgetTimer: ReturnType<typeof setTimeout> | null = null

/** 保存编辑后延迟检查总预算：合并连续写回，避免每次保存都全目录扫描 */
export function scheduleBackupBudgetCheck(delay = 3000): void {
  if (backupBudgetTimer) clearTimeout(backupBudgetTimer)
  backupBudgetTimer = setTimeout(() => {
    backupBudgetTimer = null
    void enforceBackupBudget().catch((err) => logError('backupBudget', err))
  }, delay)
}

/** 路径变更（批量重命名）后把该照片的编辑备份重绑定到新路径哈希，历史保持可恢复（O3） */
export function rekeyEditBackups(id: number, newPath: string): void {
  rekeyEditBackupsBatch([{ id, newPath }])
}

/** 批量重命名的备份重绑定（OPT-43）：一次 readdir 建立 id→files 索引后整批处理，
 *  替代逐张全目录扫描的 O(N×M) 同步 IO */
export function rekeyEditBackupsBatch(entries: { id: number; newPath: string }[]): void {
  if (!entries.length) return
  let names: string[]
  try {
    names = fs.readdirSync(backupsDir())
  } catch {
    return
  }
  const byId = new Map<number, { name: string; hash: string; ts: string; ext: string }[]>()
  for (const n of names) {
    const m = /^(\d+)-([0-9a-f]{8})-(\d+)\.([a-z0-9]+)$/i.exec(n)
    if (!m) continue
    const id = Number(m[1])
    const list = byId.get(id)
    const item = { name: n, hash: m[2].toLowerCase(), ts: m[3], ext: `.${m[4]}` }
    if (list) list.push(item)
    else byId.set(id, [item])
  }
  for (const { id, newPath } of entries) {
    const hash = pathHash(newPath)
    for (const f of byId.get(id) ?? []) {
      // 哈希已匹配（含大小写变体重命名）：无需重绑定
      if (f.hash === hash) continue
      try {
        fs.renameSync(path.join(backupsDir(), f.name), path.join(backupsDir(), `${id}-${hash}-${f.ts}${f.ext}`))
      } catch {
        /* 单个失败忽略 */
      }
    }
  }
}

/**
 * 启动时把裸 id 命名的旧版编辑备份按当前库重绑定（一次性）：
 * 行已不存在的（历史换库残留）留作孤儿文件，不再对外提供。
 */
export function migrateLegacyEditBackups(): void {
  let names: string[]
  try {
    names = fs.readdirSync(backupsDir())
  } catch {
    return
  }
  // 旧版命名：{id}-{ts}.{ext}；行存在性经一次批量取行判定（OPT-43），不再逐文件点查
  const legacy = names
    .map((n) => ({ n, m: /^(\d+)-(\d+)\.([a-z0-9]+)$/i.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
  if (!legacy.length) return
  const rows = listPhotoRowsByIds(legacy.map((x) => Number(x.m[1])))
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const { n, m } of legacy) {
    const row = byId.get(Number(m[1]))
    if (!row) continue
    try {
      fs.renameSync(
        path.join(backupsDir(), n),
        path.join(backupsDir(), backupNameOf(Number(m[1]), row.path, Number(m[2]), `.${m[3]}`))
      )
    } catch {
      /* 单个失败忽略 */
    }
  }
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

/**
 * 原子替换目标文件（Windows 无覆盖式 rename，先 rm 再 rename 的崩溃窗口内原图会彻底消失）：
 * 原图先移位为 .framora-old——任意时刻原图字节都存在于某个路径；
 * 新内容落位失败时把原图放回原位（取消本次变更，不留空档）；
 * 崩溃残留的 .framora-old 由下一次替换前的兜底清理移除。
 */
async function atomicReplace(target: string, src: string): Promise<void> {
  const old = `${target}.framora-old`
  // 崩溃残留恢复：目标缺失而残留存在时，说明上次替换中断在「原图已移位、新图未落位」
  // 之间——残留即原图唯一副本，先放回原位再走正常流程（放回后 rm 成为无害空操作）。
  // 若无条件 rm，会在 revertEdits 允许的目标缺失路径上删掉这份唯一副本。
  if (!fs.existsSync(target) && fs.existsSync(old)) {
    await fs.promises.rename(old, target).catch(() => undefined)
  }
  await fs.promises.rm(old, { force: true })
  // 目标缺失（如恢复编辑到已丢失的源文件）：跳过移位，直接落位（恢复语义允许重建文件）
  const movedAside = fs.existsSync(target)
  if (movedAside) await fs.promises.rename(target, old)
  try {
    await fs.promises.rename(src, target)
  } catch (err) {
    if (movedAside) await fs.promises.rename(old, target).catch(() => undefined)
    throw err
  }
  await fs.promises.rm(old, { force: true }).catch(() => undefined)
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
  if (isRawExt(row.ext)) throw new Error('RAW 文件不支持写回编辑，请使用导出转换格式')
  // GIF（动画写回会丢帧）与 BMP（无编码器）不支持写回：否则会落入下方 else 分支
  // 静默产出 JPEG 内容并 atomicReplace 覆盖原文件，属数据破坏
  if (row.ext === 'gif' || row.ext === 'bmp')
    throw new Error('GIF/BMP 文件不支持写回编辑，请使用导出转换格式')
  const backupName = backupNameOf(id, row.path, Date.now(), path.extname(row.path))
  const backupPath = path.join(backupsDir(), backupName)
  // 备份副本与临时编码输出分别落在两个目录，需各自探测余量，避免写到一半 ENOSPC
  const srcStat = await fs.promises.stat(row.path)
  await assertFreeSpace(backupsDir(), srcStat.size + 64 * 1024 * 1024, '保存编辑备份')
  await assertFreeSpace(
    path.dirname(row.path),
    srcStat.size + 64 * 1024 * 1024,
    '写入编辑结果'
  )
  await fs.promises.copyFile(row.path, backupPath)
  void prunePhotoBackups(id)

  const tmp = `${row.path}.framora-tmp${path.extname(row.path)}`
  try {
    // withMetadata 保留 EXIF/ICC 等元数据；像素已按 EXIF/应用方向烘焙为正立，
    // Orientation 显式重写为 1（保存后应用层 orientation 已重置为 0），避免其他软件二次旋转
    let pipe = sharp(row.path, { failOn: 'none' }).rotate().withMetadata({ orientation: 1 })
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
    applyAdjustments(pipe, edit)

    // 保持源格式；PNG 保持无损，JPEG 默认 q92
    if (row.ext === 'jpg' || row.ext === 'jpeg') pipe = pipe.jpeg({ quality: 92 })
    else if (row.ext === 'webp') pipe = pipe.webp({ quality: 90 })
    else if (row.ext === 'png') pipe = pipe.png()
    else if (row.ext === 'tif' || row.ext === 'tiff') pipe = pipe.tiff()
    else pipe = pipe.jpeg({ quality: 92 })

    await pipe.toFile(tmp)
    await atomicReplace(row.path, tmp)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }

  const st = await fs.promises.stat(row.path)
  updatePhotoFileFields(id, { size: st.size, mtime: Math.round(st.mtimeMs) })
  updatePhotoMeta(id, { orientation: 0, flip_h: 0, flip_v: 0 })
  enqueueThumb(id)
  scheduleBackupBudgetCheck()
}

export async function listBackups(id: number): Promise<BackupInfo[]> {
  // 只列出绑定当前照片路径哈希的备份：换库后 id 错位的旧备份不对外提供（O3）
  const row = getPhotoRow(id)
  const hash = row ? pathHash(row.path) : null
  if (!hash) return []
  let names: string[]
  try {
    names = await fs.promises.readdir(backupsDir())
  } catch {
    return []
  }
  const out: BackupInfo[] = []
  for (const n of names) {
    const m = backupNameRe(id).exec(n)
    if (!m || m[1].toLowerCase() !== hash) continue
    const st = await fs.promises.stat(path.join(backupsDir(), n)).catch(() => null)
    out.push({ name: n, ts: Number(m[2]), size: st?.size ?? 0 })
  }
  out.sort((a, b) => b.ts - a.ts)
  return out
}

/** 恢复编辑：默认最近一份备份，可指定历史备份名（编辑历史面板） */
export async function revertEdits(id: number, backupName?: string): Promise<void> {
  const row = getPhotoRow(id)
  if (!row) throw new Error('照片不存在')
  const hash = pathHash(row.path)
  let latest: string
  if (backupName !== undefined) {
    // 身份校验：备份必须绑定当前照片的路径哈希，换库错位的旧备份一律拒绝（O3）
    const m = backupNameRe(id).exec(backupName)
    if (!m || m[1].toLowerCase() !== hash) throw new Error('无效的备份文件名')
    latest = path.join(backupsDir(), backupName)
    if (!fs.existsSync(latest)) throw new Error('备份文件不存在')
  } else {
    const files = (
      await fs.promises.readdir(backupsDir()).catch(() => [] as string[])
    ).filter((n) => {
      const m = backupNameRe(id).exec(n)
      return !!m && m[1].toLowerCase() === hash
    })
    if (!files.length) throw new Error('没有可恢复的编辑备份')
    const tsOf = (n: string): number => Number(backupNameRe(id).exec(n)?.[2] ?? 0)
    files.sort((a, b) => tsOf(b) - tsOf(a))
    latest = path.join(backupsDir(), files[0])
  }
  // 恢复前先备份当前状态（OPT-33）：此前被覆盖的「当前编辑结果」没有任何副本，
  // 恢复是不可逆的单向操作。先备份形成 A↔B 往返——恢复后可再次撤销回当前版本，
  // 与 saveEdits 的备份共用同一命名、上限与预算清理
  if (fs.existsSync(row.path)) {
    const curStat = await fs.promises.stat(row.path)
    await assertFreeSpace(backupsDir(), curStat.size + 64 * 1024 * 1024, '恢复前备份')
    const curBackup = backupNameOf(id, row.path, Date.now(), path.extname(row.path))
    await fs.promises.copyFile(row.path, path.join(backupsDir(), curBackup))
    void prunePhotoBackups(id)
  }
  // tmp 写入后经 atomicReplace 原子落位（直接覆盖已存在文件在 Windows 上可能因目标被占用报 UNKNOWN）
  const tmp = `${row.path}.framora-revert-tmp${path.extname(row.path)}`
  const backupStat = await fs.promises.stat(latest)
  await assertFreeSpace(
    path.dirname(row.path),
    backupStat.size * 2 + 32 * 1024 * 1024,
    '恢复编辑'
  )
  try {
    await fs.promises.copyFile(latest, tmp)
    await atomicReplace(row.path, tmp)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  const st = await fs.promises.stat(row.path)
  updatePhotoFileFields(id, { size: st.size, mtime: Math.round(st.mtimeMs), missing: 0 })
  updatePhotoMeta(id, { orientation: 0, flip_h: 0, flip_v: 0 })
  enqueueThumb(id)
}
