/** UI 冒烟测试：连接 CDP，驱动真实窗口截图并断言关键流程 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const OUT = path.join(tmpdir(), 'framora-ui-test')
mkdirSync(OUT, { recursive: true })

const shot = (page, name) =>
  page.screenshot({ path: path.join(OUT, name) }).then(() => console.log(`shot: ${name}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(msg) {
  console.error('FAIL: ' + msg)
  process.exitCode = 1
}

const PORT = process.argv[2] ?? '9222'
const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${PORT}`,
  defaultViewport: null
})
const target = browser
  .targets()
  .find((t) => t.type() === 'page' && (t.url().startsWith('file:') || t.url().includes('localhost')))
if (!target) {
  fail('找不到应用窗口 target')
  process.exit(1)
}
const page = await target.page()
console.log('connected:', target.url())

/* 1. 空状态 */
await sleep(1500)
await shot(page, '01-empty-state.png')
const emptyText = await page.evaluate(() => document.body.innerText.slice(0, 200))
console.log('empty-state text:', emptyText.replace(/\n/g, ' | ').slice(0, 120))

/* 2. 通过真实 IPC 导入测试文件夹（绕过原生对话框，其余流程与真实导入完全一致） */
const tmpData = path.join(tmpdir(), 'framora-testdata')
const importResult = await page.evaluate(
  (dir) => window.framora.invoke('library:importFolder', dir),
  tmpData
)
console.log('import result:', JSON.stringify(importResult))
if (!importResult) fail('导入失败')

/* 3. 等待缩略图生成完成（轮询状态栏文案消失） */
let pendingCount = -1
for (let i = 0; i < 120; i++) {
  await sleep(500)
  pendingCount = await page.evaluate(
    () => window.framora.invoke('photos:query', { scope: 'all', limit: 100000 }).then((r) => r.items.filter((p) => p.thumb_status === 0).length)
  )
  if (pendingCount === 0) break
}
console.log('pending thumbs:', pendingCount)
if (pendingCount !== 0) fail('缩略图未全部生成')

/* 4. 网格渲染断言 */
await sleep(800)
const gridImgs = await page.evaluate(() => document.querySelectorAll('[data-testid="photo-grid"] img').length)
console.log('visible grid imgs:', gridImgs)
if (gridImgs === 0) fail('网格没有渲染出缩略图')
await shot(page, '02-grid.png')

/* 5. 打开查看器：单击选中 + 回车 */
const firstImg = await page.$('[data-testid="photo-grid"] img')
await firstImg.click()
await sleep(300)
await page.keyboard.press('Enter')
await sleep(1200)
const viewerVisible = await page.evaluate(() => {
  const el = document.querySelector('img[src^="media://"]')
  return !!el && el.clientWidth > 100
})
console.log('viewer visible:', viewerVisible)
if (!viewerVisible) fail('查看器未打开')
await shot(page, '03-viewer.png')

/* 6. 查看器内操作：下一张、旋转、缩放（滚轮） */
await page.keyboard.press('ArrowRight')
await sleep(500)
await page.evaluate(() => {
  const canvas = document.querySelector('img[src^="media://"]').parentElement
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
})
await sleep(400)
const zoomLabel = await page.evaluate(() => document.body.innerText.match(/\d+%/)?.[0])
console.log('zoom label:', zoomLabel)
if (!zoomLabel || zoomLabel === '100%') fail('滚轮缩放未生效')
await shot(page, '04-viewer-zoom.png')

/* 7. 打开信息面板（EXIF / 元数据） */
await page.keyboard.press('Escape')
await sleep(400)
const infoBtnIdx = await page.evaluate(() => {
  return undefined
})
// 点击工具栏信息按钮（title=信息面板）
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.title === '信息面板')
  btn?.click()
})
await sleep(1000)
const detailShown = await page.evaluate(() => document.body.innerText.includes('文件信息'))
console.log('detail panel:', detailShown)
if (!detailShown) fail('信息面板未显示')
await shot(page, '05-detail-panel.png')

/* 8. 搜索 */
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.title === '信息面板')
  btn?.click()
})
await sleep(300)
await page.type('input[placeholder*="搜索"]', 'IMG_1050', { delay: 30 })
await sleep(900)
const searchTotal = await page.evaluate(() =>
  window.framora.invoke('photos:query', { scope: 'all', keyword: 'IMG_1050' }).then((r) => r.total)
)
console.log('search IMG_1050 total:', searchTotal)
if (searchTotal !== 1) fail(`搜索应命中 1 张，实际 ${searchTotal}`)
await shot(page, '06-search.png')

/* 9. 清空搜索 + 批量选择 + 星级 */
await page.evaluate(() => {
  const input = document.querySelector('input[placeholder*="搜索"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(900)
await page.keyboard.press('Escape')
await page.evaluate(() => {
  // Ctrl+A 全选
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
})
await sleep(400)
const selectedCount = await page.evaluate(() => document.body.innerText.match(/已选 (\d+) 项/)?.[1])
console.log('selected:', selectedCount)
if (selectedCount !== '300') fail(`全选应选中 300 项，实际 ${selectedCount}`)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.title === '设置星级')
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: btn.getBoundingClientRect().x, clientY: btn.getBoundingClientRect().y }))
})
await sleep(500)
await page.evaluate(() => {
  const item = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '★★★★★')
  item?.click()
})
await sleep(900)
const rated = await page.evaluate(() =>
  window.framora.invoke('photos:query', { scope: 'all', minRating: 5 }).then((r) => r.total)
)
console.log('5-star count:', rated)
if (rated !== 300) fail(`批量星级应作用于 300 张，实际 ${rated}`)
await shot(page, '07-batch-rate.png')

/* 10. 批量标签 */
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.title === '添加标签')
  btn?.click()
})
await sleep(400)
await page.type('input[placeholder="新建标签…"]', '测试标签', { delay: 20 })
await page.keyboard.press('Enter')
await sleep(1000)
const tagged = await page.evaluate(() =>
  window.framora.invoke('tags:list').then((l) => l.find((t) => t.name === '测试标签')?.count ?? 0)
)
console.log('tag count:', tagged)
if (tagged !== 300) fail(`批量标签应作用于 300 张，实际 ${tagged}`)
await shot(page, '08-batch-tag.png')

/* 11. 主题切换 */
await page.keyboard.press('Escape')
await sleep(300)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.title === '切换浅色主题')
  btn?.click()
})
await sleep(600)
const isLight = await page.evaluate(() => !document.documentElement.classList.contains('dark'))
console.log('light theme:', isLight)
if (!isLight) fail('浅色主题未生效')
await shot(page, '09-light-theme.png')

/* 12. 性能：万级查询耗时 */
const perf = await page.evaluate(() => {
  const t0 = performance.now()
  return window.framora
    .invoke('photos:query', { scope: 'all', sort: 'rating', dir: 'desc' })
    .then((r) => ({ total: r.total, ms: Math.round(performance.now() - t0) }))
})
console.log('query perf:', JSON.stringify(perf))

writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: process.exitCode == null }))
console.log('screenshots at', OUT)
browser.disconnect()
