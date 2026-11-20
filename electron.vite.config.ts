import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * 生产环境 CSP：移除 dev 专用源（localhost / ws）与 script unsafe-inline。
 * dev 保留宽松 CSP（Vite HMR 与 react-refresh 需要内联脚本与 ws）。
 */
const prodCspPlugin = (): Plugin => ({
  name: 'framora:prod-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: media: thumb:; font-src 'self' data:; connect-src 'self'" />`
    )
  }
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        // 相似聚类 worker（phashCluster.ts 经 worker_threads 加载，见 out/main/phashWorker.js）
        input: {
          index: resolve('src/main/index.ts'),
          phashWorker: resolve('src/main/phashWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), prodCspPlugin()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
