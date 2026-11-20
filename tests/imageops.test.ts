import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pickName } from '../src/main/imageops'

describe('pickName 导出命名防覆盖', () => {
  it('目标目录无同名文件时使用原始名称', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-export-'))
    const r = pickName(dir, 'IMG_1001', 'jpg', new Set())
    expect(r.outName).toBe('IMG_1001.jpg')
  })

  it('磁盘已有同名文件时追加序号', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-export-'))
    writeFileSync(path.join(dir, 'IMG_1001.jpg'), 'x')
    const r = pickName(dir, 'IMG_1001', 'jpg', new Set())
    expect(r.outName).toBe('IMG_1001(1).jpg')
  })

  it('本次导出会话内已使用的名称不重复分配', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'framora-export-'))
    const used = new Set<string>()
    const first = pickName(dir, 'a', 'png', used)
    used.add(first.outPath.toLowerCase())
    const second = pickName(dir, 'a', 'png', used)
    expect(second.outName).toBe('a(1).png')
  })
})
