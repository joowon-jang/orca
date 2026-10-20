import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffSection } from '../../diff-section-types'

export type CachedCombinedDiffViewState = {
  entrySignature: string
  gitStatusSignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  sideBySide: boolean
}

type CombinedDiffViewMemory = {
  worktreeId: string
  view?: CachedCombinedDiffViewState
  scrollTop?: number
  scrollAnchor?: NonNullable<VirtualizedScrollAnchor>
}

/** A mounted viewer's write access to its key; revoked only when its workspace is forgotten. */
export type CombinedDiffViewLease = {
  readonly viewKey: string
  worktreeId: string
  revoked: boolean
}

const memoryByViewKey = new Map<string, CombinedDiffViewMemory>()
const mountedLeases = new Set<CombinedDiffViewLease>()

export function readCombinedDiffViewMemory(
  viewKey: string
): Readonly<CombinedDiffViewMemory> | undefined {
  return memoryByViewKey.get(viewKey)
}

export function claimCombinedDiffView(viewKey: string, worktreeId: string): CombinedDiffViewLease {
  if (memoryByViewKey.get(viewKey)?.worktreeId !== worktreeId) {
    memoryByViewKey.delete(viewKey)
  }
  const lease = { viewKey, worktreeId, revoked: false }
  mountedLeases.add(lease)
  return lease
}

// Why: release only stops tracking — the viewer's unmount snapshot still writes through the lease afterwards.
export function releaseCombinedDiffView(lease: CombinedDiffViewLease): void {
  mountedLeases.delete(lease)
}

export function rememberCombinedDiffView(
  lease: CombinedDiffViewLease | null,
  patch: Partial<Omit<CombinedDiffViewMemory, 'worktreeId'>>
): void {
  if (!lease || lease.revoked) {
    return
  }
  const memory = memoryByViewKey.get(lease.viewKey)
  const owned = memory?.worktreeId === lease.worktreeId ? memory : { worktreeId: lease.worktreeId }
  setWithLRU(memoryByViewKey, lease.viewKey, { ...owned, ...patch })
}

export function forgetCombinedDiffViewsShowingPath(relativePath: string): void {
  for (const [viewKey, memory] of memoryByViewKey) {
    if (memory.view?.sections.some((section) => section.path === relativePath)) {
      memoryByViewKey.set(viewKey, { ...memory, view: undefined })
    }
  }
}

export function renameCombinedDiffViewOwner(oldWorktreeId: string, newWorktreeId: string): void {
  for (const [viewKey, memory] of memoryByViewKey) {
    if (memory.worktreeId === oldWorktreeId) {
      memoryByViewKey.set(viewKey, { ...memory, worktreeId: newWorktreeId })
    }
  }
  for (const lease of mountedLeases) {
    if (lease.worktreeId === oldWorktreeId) {
      lease.worktreeId = newWorktreeId
    }
  }
}

/** A deleted workspace cannot restore its cached file bodies. Ordinary tab closes keep them. */
export function forgetCombinedDiffViewsForWorktrees(worktreeIds: Iterable<string>): void {
  const removed = new Set(worktreeIds)
  for (const [viewKey, memory] of memoryByViewKey) {
    if (removed.has(memory.worktreeId)) {
      memoryByViewKey.delete(viewKey)
    }
  }
  for (const lease of mountedLeases) {
    if (removed.has(lease.worktreeId)) {
      lease.revoked = true
      mountedLeases.delete(lease)
    }
  }
}

export function clearCombinedDiffViewMemory(): void {
  memoryByViewKey.clear()
  mountedLeases.clear()
}
