/**
 * 将 better-sqlite3 对齐到已安装 Electron 的 ABI。
 *
 * 测试与部分脚本以 Electron-as-Node 运行（见 run-vitest.mjs），
 * better-sqlite3 必须按 Electron ABI 预编译；npm 默认只会下载
 * 当前系统 Node 的预编译产物，导致 NODE_MODULE_VERSION 不匹配。
 * 官方发布包含 electron 运行时的预编译包，直接下载即可，无需本地编译。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootRequire = createRequire(import.meta.url)
const bs3Dir = path.dirname(rootRequire.resolve('better-sqlite3/package.json'))
// 从 better-sqlite3 上下文解析 prebuild-install，兼容嵌套/提升两种布局
const bs3Require = createRequire(path.join(bs3Dir, 'package.json'))
const prebuildDir = path.dirname(bs3Require.resolve('prebuild-install/package.json'))
const binField = bs3Require('prebuild-install/package.json').bin
const binRelPath = typeof binField === 'string' ? binField : binField['prebuild-install']
const prebuildBin = path.join(prebuildDir, binRelPath)
const electronVersion = rootRequire('electron/package.json').version

const result = spawnSync(process.execPath, [prebuildBin, '-r', 'electron', '-t', electronVersion, '--verbose'], {
  cwd: bs3Dir,
  stdio: 'inherit'
})

if (result.status !== 0) {
  console.error(`\n[rebuild-native] 下载 electron@${electronVersion} 的 better-sqlite3 预编译包失败。`)
  console.error('[rebuild-native] GitHub Releases 不可达时，可设置镜像后重试：')
  console.error('[rebuild-native]   npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3')
  console.error('[rebuild-native] 或改用 npx @electron/rebuild 本地编译。')
}
process.exit(result.status ?? 1)
