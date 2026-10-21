import type { StateCreator } from 'zustand'
import {
  editorBufferMirrorMismatch,
  reconcileEditorBufferMembership,
  type EditorBufferState
} from './slices/editor/buffers/editor-buffer-record'

/**
 * Ties editor buffer records to `openFiles` membership inside the same write: a new tab's record
 * is seeded from the tab and a closed tab's record is dropped. Field writes go through the record
 * (`writeEditorBuffer`); with `checkInvariant` a write that drifts a tab mirror from it throws.
 */
function reconcileEditorBuffers<TState extends EditorBufferState>(
  state: TState,
  write: TState | Partial<TState>,
  checkInvariant: boolean
): TState | Partial<TState> {
  const openFiles = write.openFiles ?? state.openFiles
  const records = write.editorBuffers ?? state.editorBuffers
  if (openFiles === state.openFiles && records === state.editorBuffers) {
    return write
  }
  const next = reconcileEditorBufferMembership(records, openFiles)
  if (checkInvariant) {
    assertEditorBufferInvariant({ openFiles, editorBuffers: next })
  }
  return next === records ? write : { ...write, editorBuffers: next }
}

export function assertEditorBufferInvariant(state: EditorBufferState): void {
  const ids = new Set(state.openFiles.map((file) => file.id))
  const recordIds = Object.keys(state.editorBuffers)
  if (recordIds.length !== ids.size || recordIds.some((id) => !ids.has(id))) {
    throw new Error('Editor buffer records are not keyed by the open editor tabs')
  }
  for (const file of state.openFiles) {
    const field = editorBufferMirrorMismatch(file, state.editorBuffers[file.id])
    if (field !== null) {
      throw new Error(`Editor buffer mirror "${field}" of ${file.id} differs from its record`)
    }
  }
}

export function withEditorBufferRecords<TState extends EditorBufferState>(
  createState: StateCreator<TState, [], []>,
  checkInvariant: boolean = import.meta.env.DEV
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    const wrap = (write: typeof set): typeof set => {
      const wrapped = (
        partial: TState | Partial<TState> | ((state: TState) => TState | Partial<TState>),
        replace?: boolean
      ): void => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the caller's own partial/replace pair; with replace=true the updater still yields a full state.
        ;(write as (next: (state: TState) => TState | Partial<TState>, replace?: boolean) => void)(
          (state) =>
            reconcileEditorBuffers(
              state,
              typeof partial === 'function' ? partial(state) : partial,
              checkInvariant
            ),
          replace
        )
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one implementation serves both zustand setState overloads.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState)
    return createState(wrap(set), get, api)
  }
}
