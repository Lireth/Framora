import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    coverage: {
      // 覆盖率门禁（OPT-50）：统计 src/main + shared + build 全部源文件（含零覆盖
      // 的入口/胶水模块，默认 all 行为）。当前真实基线 ≈ 语句 58% / 分支 51% ——
      // 已测试模块自身在 83%/68%，但 ipc/index/watcher 等安全边界仍是 0%；
      // 阈值锁定当前下限防止无感下滑，随 OPT-50 后续为 ipc/index 补测试后上调。
      // 渲染层暂无测试基建，不计入。
      include: ['src/main/**', 'src/shared/**', 'src/build/**'],
      thresholds: { statements: 58, branches: 51, functions: 54, lines: 61 }
    }
  }
})
