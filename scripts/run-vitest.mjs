/**
 * 测试运行器：以 Electron-as-Node 方式启动 vitest。
 * 原生模块（better-sqlite3 / sharp）按 Electron ABI 预编译，
 * 系统 Node 直接加载会报 NODE_MODULE_VERSION 不匹配；
 * Electron 以 RUN_AS_NODE 模式运行即为其自带 ABI 的 Node 运行时。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronBin = require('electron')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let vitestEntry
try {
  vitestEntry = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
} catch {
  vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
}

const child = spawn(electronBin, [vitestEntry, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
