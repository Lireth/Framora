/** 生成测试照片到系统临时目录（仅用于开发验证，不属于交付内容） */
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const COUNT = Number(process.argv[2] ?? 300)
const outDir = path.join(tmpdir(), 'framora-testdata')
mkdirSync(outDir, { recursive: true })

const hues = [8, 32, 55, 90, 140, 175, 205, 240, 275, 310]

async function gen(i) {
  const hue = hues[i % hues.length]
  const w = 1200 + ((i * 37) % 900)
  const h = 800 + ((i * 53) % 700)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="hsl(${hue}, 62%, 58%)"/>
        <stop offset="1" stop-color="hsl(${(hue + 60) % 360}, 55%, 34%)"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.62}" cy="${h * 0.38}" r="${Math.min(w, h) * 0.2}" fill="hsl(${(hue + 180) % 360}, 70%, 72%)" opacity="0.85"/>
    <rect x="${w * 0.12}" y="${h * 0.6}" width="${w * 0.3}" height="${h * 0.24}" rx="24" fill="hsl(${(hue + 40) % 360}, 40%, 26%)" opacity="0.9"/>
  </svg>`
  const name = `IMG_${String(1000 + i)}.jpg`
  await sharp(Buffer.from(svg))
    .jpeg({ quality: 88 })
    .withMetadata({ exif: { IFD0: { Make: 'FramoraTest', Model: `Cam-${i % 3}` } } })
    .toFile(path.join(outDir, name))
}

const started = Date.now()
const batch = 20
for (let i = 0; i < COUNT; i += batch) {
  await Promise.all(Array.from({ length: batch }, (_, k) => gen(i + k)))
}
console.log(`generated ${COUNT} test photos at ${outDir} in ${Date.now() - started}ms`)
