import type { ThemeMode } from '@shared/types'

/** 窗口创建前的背景色（首帧），= --c-bg；入参应为已解析的 dark/light（system 需先经 nativeTheme 解析） */
export function themeBackground(mode: ThemeMode): string {
  return mode === 'light' ? '#f5f4f0' : '#101014'
}
