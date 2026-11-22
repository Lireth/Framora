/**
 * 查看器子模块共享类型与常量（自 Viewer.tsx 拆出，OPT-36）。
 */
import type { CropRect } from '@shared/types'

export interface EditState {
  rotateDelta: number
  flipH: boolean
  flipV: boolean
  brightness: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  sharpen: number
  crop: CropRect | null
}

export const EDIT_RESET: EditState = {
  rotateDelta: 0,
  flipH: false,
  flipV: false,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  sharpen: 0,
  crop: null
}

export type Aspect = 'free' | '1:1' | '4:3' | '3:2' | '16:9'
export const ASPECT_RATIOS: [Aspect, number, number][] = [
  ['free', 0, 0],
  ['1:1', 1, 1],
  ['4:3', 4, 3],
  ['3:2', 3, 2],
  ['16:9', 16, 9]
]
