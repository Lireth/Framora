/**
 * 撤销栈持久化（自 ipc.ts 抽取，OPT-22）：跨重启保留最近的可撤销元数据删除
 * （文件夹/标签/相册）。栈管理与持久化格式过滤为纯逻辑，注入读写便于单元测试；
 * ipc 层仅负责把各类恢复动作接到 db。
 */
import type { UndoEntry, UndoKind } from '@shared/types'

export const UNDO_MAX = 10

/** 持久化条目过滤：损坏或旧版本数据直接剔除，不抛错不污染栈 */
export function isUndoEntry(v: unknown): v is UndoEntry {
  const o = v as Partial<UndoEntry> | null
  return (
    !!o &&
    (o.kind === 'folder' || o.kind === 'tag' || o.kind === 'album' || o.kind === 'smart') &&
    typeof o.id === 'number' &&
    Number.isFinite(o.id) &&
    typeof o.label === 'string' &&
    typeof o.photos === 'number' &&
    typeof o.at === 'number'
  )
}

export interface UndoStorage {
  read(): string | null
  write(raw: string): void
}

export class UndoStore {
  private stack: UndoEntry[] = []

  constructor(private readonly storage: UndoStorage) {}

  /** 启动时从持久层恢复；非法条目（损坏/旧版本）直接过滤 */
  load(): void {
    try {
      const raw = this.storage.read()
      if (!raw) return
      const list = JSON.parse(raw) as unknown
      this.stack = Array.isArray(list) ? list.filter(isUndoEntry).slice(-UNDO_MAX) : []
    } catch {
      this.stack = []
    }
  }

  peek(): UndoEntry | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null
  }

  /** 弹出栈顶（撤销执行成功后调用）并持久化 */
  pop(): UndoEntry | null {
    const e = this.stack.pop() ?? null
    if (e) this.save()
    return e
  }

  push(e: Omit<UndoEntry, 'at'>): void {
    this.stack.push({ ...e, at: Date.now() })
    if (this.stack.length > UNDO_MAX) this.stack.splice(0, this.stack.length - UNDO_MAX)
    this.save()
  }

  /** 条目已通过其他路径恢复（重新导入 / 同名新建）时移除，避免状态栏展示过期撤销 */
  drop(kind: UndoKind, id: number): boolean {
    const next = this.stack.filter((x) => !(x.kind === kind && x.id === id))
    if (next.length === this.stack.length) return false
    this.stack = next
    this.save()
    return true
  }

  /** 换库后旧实体 id 全部失效：清空整个栈 */
  clear(): void {
    if (!this.stack.length) return
    this.stack = []
    this.save()
  }

  private save(): void {
    try {
      this.storage.write(JSON.stringify(this.stack))
    } catch {
      /* 持久化失败不影响会话内撤销 */
    }
  }
}
