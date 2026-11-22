import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

/**
 * 渲染期异常兜底（OPT-20）：任何未捕获的渲染错误此前会让整个窗口白屏，
 * 只能重启应用。捕获后展示可读的错误态与「重新加载」入口。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 与主进程日志同目录体系暂不可用（渲染端无 log 通道），错误细节展示给用户
    console.error('渲染进程未捕获异常:', error, info.componentStack)
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-app px-8 text-center">
          <p className="text-[15px] font-semibold text-ink">界面出现了一个错误</p>
          <p className="max-w-[480px] break-all text-[12px] leading-relaxed text-ink3">
            {this.state.error.message}
          </p>
          <button
            onClick={() => {
              this.setState({ error: null })
              window.location.reload()
            }}
            className="rounded-md bg-[var(--c-accent)] px-4 py-2 text-[13px] font-medium text-[#171310] hover:bg-[var(--c-accent-hover)]"
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
