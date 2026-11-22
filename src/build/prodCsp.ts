/**
 * 生产环境 CSP 替换（自 electron.vite.config.ts 抽取，OPT-27）：
 * 移除 dev 专用源（localhost / ws）与 script unsafe-inline。
 * dev 保留宽松 CSP（Vite HMR 与 react-refresh 需要内联脚本与 ws）。
 *
 * 此前替换用 String.replace + 正则，若 index.html 的 meta 格式变化导致
 * 匹配失败会静默降级——生产包带着 `script-src 'unsafe-inline'` 出厂且
 * 无人知晓。此处改为「未命中即抛错终止构建」，把静默失败变成构建失败。
 */
import type { Plugin } from 'vite'

/** 生产 CSP meta 标签（与 dev 版互斥替换） */
export const PROD_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: media: thumb:; font-src 'self' data:; connect-src 'self'" />`

const DEV_CSP_RE = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/

export function replaceProdCsp(html: string): string {
  if (!DEV_CSP_RE.test(html)) {
    throw new Error(
      'prodCspPlugin: index.html 中未找到 Content-Security-Policy meta 标签——' +
        '生产 CSP 收紧不会生效，拒绝构建。请检查 dev CSP meta 的格式是否仍可匹配。',
    )
  }
  const out = html.replace(DEV_CSP_RE, PROD_CSP_META)
  // 双保险：替换结果必须包含收紧版原样 meta，且不再含 dev 专用源
  if (!out.includes(PROD_CSP_META) || /localhost|ws:\/\//.test(out)) {
    throw new Error('prodCspPlugin: CSP 替换结果异常（dev 专用源残留或收紧版缺失），拒绝构建')
  }
  return out
}

export function prodCspPlugin(): Plugin {
  return {
    name: 'framora:prod-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return replaceProdCsp(html)
    },
  }
}
