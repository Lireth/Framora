import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = resolve(root, 'build')
mkdirSync(buildDir, { recursive: true })

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <rect x="128" y="128" width="256" height="256" rx="30" fill="none" stroke="#ffffff" stroke-width="26"/>
  <circle cx="256" cy="256" r="50" fill="#ffffff"/>
</svg>`

async function main() {
  const png = await sharp(Buffer.from(svg), { density: 300 })
    .resize(256, 256)
    .png()
    .toBuffer()
  writeFileSync(resolve(buildDir, 'icon.png'), png)
  const ico = await pngToIco([png])
  writeFileSync(resolve(buildDir, 'icon.ico'), ico)
  console.log('[icon] build/icon.png & build/icon.ico generated')
}

main().catch((e) => {
  console.warn('[icon] generation skipped:', e.message)
})
