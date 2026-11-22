/**
 * 撤销栈纯逻辑回归（OPT-22 抽取自 ipc.ts）：
 * push/peek/pop/drop/clear 语义、持久化往返、损坏数据过滤、容量上限。
 */
import { describe, expect, it, vi } from 'vitest'
import { UNDO_MAX, UndoStore, isUndoEntry } from '../src/main/undo'
import type { UndoEntry } from '@shared/types'

function memoryStore(initial?: string): { store: UndoStore; writes: string[] } {
  const writes: string[] = []
  let value = initial ?? null
  const store = new UndoStore({
    read: () => value,
    write: (raw) => {
      value = raw
      writes.push(raw)
    },
  })
  return { store, writes }
}

const entry = (kind: 'folder' | 'tag' | 'album', id: number): Omit<UndoEntry, 'at'> => ({
  kind,
  id,
  label: `${kind}-${id}`,
  photos: 3,
})

describe('isUndoEntry 格式过滤', () => {
  it('接受合法条目', () => {
    expect(isUndoEntry({ kind: 'folder', id: 1, label: 'x', photos: 0, at: 1 })).toBe(true)
  })
  it('拒绝损坏/旧版本条目', () => {
    expect(isUndoEntry(null)).toBe(false)
    expect(isUndoEntry({ kind: 'unknown', id: 1, label: 'x', photos: 0, at: 1 })).toBe(false)
    expect(isUndoEntry({ kind: 'tag', id: 'x', label: 'x', photos: 0, at: 1 })).toBe(false)
    expect(isUndoEntry({ kind: 'tag', id: 1, label: 5, photos: 0, at: 1 })).toBe(false)
    expect(isUndoEntry({ kind: 'tag', id: 1, label: 'x', photos: '0', at: 1 })).toBe(false)
    expect(isUndoEntry({ kind: 'tag', id: 1, label: 'x', photos: 0 })).toBe(false)
  })
})

describe('UndoStore', () => {
  it('push/peek/pop 语义：后进先出，pop 持久化', () => {
    const { store } = memoryStore()
    store.push(entry('folder', 1))
    store.push(entry('tag', 2))
    expect(store.peek()?.id).toBe(2)
    expect(store.pop()?.id).toBe(2)
    expect(store.peek()?.id).toBe(1)
    expect(store.pop()?.id).toBe(1)
    expect(store.peek()).toBeNull()
    expect(store.pop()).toBeNull()
  })

  it('持久化往返：load 恢复栈内容', () => {
    const { store, writes } = memoryStore()
    store.push(entry('album', 7))
    store.push(entry('folder', 8))
    // 新实例从持久层数据恢复
    const store2 = new UndoStore({ read: () => writes[writes.length - 1] ?? null, write: () => undefined })
    store2.load()
    expect(store2.peek()?.id).toBe(8)
    expect(store2.pop()?.id).toBe(8)
    expect(store2.peek()?.id).toBe(7)
  })

  it('损坏 JSON / 非法条目在 load 时被过滤，不抛错', () => {
    const bad = new UndoStore({ read: () => 'not-json{', write: () => undefined })
    expect(() => bad.load()).not.toThrow()
    expect(bad.peek()).toBeNull()
    const mixed = new UndoStore({
      read: () =>
        JSON.stringify([
          { kind: 'folder', id: 1, label: 'ok', photos: 0, at: 1 },
          { kind: 'garbage' },
          null,
          'junk',
        ]),
      write: () => undefined,
    })
    mixed.load()
    expect(mixed.peek()?.id).toBe(1)
  })

  it('超出 UNDO_MAX 时丢弃最旧条目', () => {
    const { store } = memoryStore()
    for (let i = 1; i <= UNDO_MAX + 5; i++) store.push(entry('tag', i))
    expect(store.peek()?.id).toBe(UNDO_MAX + 5)
    expect(store.pop()?.id).toBe(UNDO_MAX + 5)
    // 最旧的 6 条已丢弃：弹到只剩 10-1 条后再弹应取 id=6 而非更早
    expect(store.pop()?.id).toBe(UNDO_MAX + 4)
  })

  it('drop 按类型+id 移除并持久化，无命中不写入', () => {
    const { store, writes } = memoryStore()
    store.push(entry('folder', 1))
    store.push(entry('tag', 1))
    const before = writes.length
    expect(store.drop('tag', 1)).toBe(true)
    expect(store.peek()?.kind).toBe('folder')
    expect(writes.length).toBe(before + 1)
    expect(store.drop('album', 999)).toBe(false)
    expect(writes.length).toBe(before + 1)
  })

  it('clear 清空并持久化；空栈 clear 不产生写入', () => {
    const { store, writes } = memoryStore()
    store.clear()
    expect(writes).toHaveLength(0)
    store.push(entry('folder', 1))
    const before = writes.length
    store.clear()
    expect(store.peek()).toBeNull()
    expect(writes.length).toBe(before + 1)
  })

  it('持久化失败不影响会话内栈', () => {
    const store = new UndoStore({ read: () => null, write: () => { throw new Error('disk') } })
    expect(() => store.push(entry('tag', 1))).not.toThrow()
    expect(store.peek()?.id).toBe(1)
    vi.restoreAllMocks?.()
  })
})
