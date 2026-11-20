import type { ThemeMode } from '@shared/types'

/** 窗口创建前的背景色（首帧），= --c-bg */
export function themeBackground(mode: ThemeMode): string {
  return mode === 'dark' ? '#101014' : '#f5f4f0'
}
