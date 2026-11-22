/**
 * 生产 CSP 替换回归（OPT-27）：meta 缺失/格式变化必须让构建失败，
 * 而不是静默带着 dev 宽松 CSP 出厂。
 */
import { describe, expect, it } from 'vitest'
import { PROD_CSP_META, replaceProdCsp } from '../src/build/prodCsp'

const DEV_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:5173; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: media: thumb:; connect-src 'self' ws://localhost:5173" />`

describe('replaceProdCsp', () => {
  it('dev CSP 被替换为收紧版：无 localhost/ws，script-src 无 unsafe-inline', () => {
    const out = replaceProdCsp(`<html><head><title>t</title>${DEV_META}</head><body></body></html>`)
    expect(out).toContain(PROD_CSP_META)
    expect(out).not.toContain('localhost')
    expect(out).not.toContain('ws://')
    expect(/script-src[^;]*'unsafe-inline'/.test(out)).toBe(false)
  })

  it('meta 缺失时抛错终止构建（静默降级回归）', () => {
    expect(() => replaceProdCsp('<html><head><title>no csp</title></head></html>')).toThrow(
      /Content-Security-Policy/,
    )
  })

  it('meta 改为非自闭合格式时抛错（格式漂移回归）', () => {
    const drifted = DEV_META.replace('/>', '>')
    expect(() => replaceProdCsp(`<html><head>${drifted}</head></html>`)).toThrow(
      /Content-Security-Policy/,
    )
  })
})
