import type { OpenFile } from '../types/open-file'

/**
 * Source of truth for a tab's buffer state, keyed by `OpenFile.id`. The same fields on
 * `OpenFile` are a mirror written in the same store update so existing readers keep working.
 */
export type EditorBufferRecord = Pick<
  OpenFile,
  | 'isDirty'
  | 'lastKnownDiskSignature'
  | 'externalMutation'
  | 'pendingDiskBaselineVerification'
  | 'pendingLiveDiskVerification'
  | 'pendingOwnerMigration'
>

export type EditorBufferRecords = Record<string, EditorBufferRecord>

export type EditorBufferState = { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords }

export const EDITOR_BUFFER_FIELDS = [
  'isDirty',
  'lastKnownDiskSignature',
  'externalMutation',
  'pendingDiskBaselineVerification',
  'pendingLiveDiskVerification',
  'pendingOwnerMigration'
] as const satisfies readonly (keyof EditorBufferRecord)[]

export function editorBufferRecordFromFile(file: OpenFile): EditorBufferRecord {
  return {
    isDirty: file.isDirty,
    lastKnownDiskSignature: file.lastKnownDiskSignature,
    externalMutation: file.externalMutation,
    pendingDiskBaselineVerification: file.pendingDiskBaselineVerification,
    pendingLiveDiskVerification: file.pendingLiveDiskVerification,
    pendingOwnerMigration: file.pendingOwnerMigration
  }
}

/** The file's record; a missing one is seeded from the tab, never from defaults. */
export function editorBufferOf(records: EditorBufferRecords, file: OpenFile): EditorBufferRecord {
  return records[file.id] ?? editorBufferRecordFromFile(file)
}

export function editorBufferMirrorMismatch(
  file: OpenFile,
  record: EditorBufferRecord
): keyof EditorBufferRecord | null {
  return EDITOR_BUFFER_FIELDS.find((field) => !Object.is(file[field], record[field])) ?? null
}

function patchEditorBuffer(
  records: EditorBufferRecords,
  file: OpenFile,
  patch: Partial<EditorBufferRecord>
): EditorBufferRecords {
  return {
    ...records,
    [file.id]: { ...editorBufferOf(records, file), ...patch }
  }
}

/** Writes `patch` to one file's record and its tab mirror in one update. */
export function writeEditorBuffer(
  state: EditorBufferState,
  fileId: string,
  patch: Partial<EditorBufferRecord>,
  tabPatch?: Partial<OpenFile>
): EditorBufferState {
  let editorBuffers = state.editorBuffers
  const openFiles = state.openFiles.map((file) => {
    if (file.id !== fileId) {
      return file
    }
    editorBuffers = patchEditorBuffer(editorBuffers, file, patch)
    return { ...file, ...tabPatch, ...patch }
  })
  return { openFiles, editorBuffers }
}

/** Writes `patch` through the file's record; returns `state` itself when the record already holds it. */
export function updateEditorBuffer<TState extends EditorBufferState>(
  state: TState,
  fileId: string,
  patch: Partial<EditorBufferRecord>
): TState | EditorBufferState {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file) {
    return state
  }
  const record = editorBufferOf(state.editorBuffers, file)
  const changes = EDITOR_BUFFER_FIELDS.some(
    (field) => Object.hasOwn(patch, field) && !Object.is(record[field], patch[field])
  )
  return changes ? writeEditorBuffer(state, fileId, patch) : state
}

/** A host-mirrored tab carries the host's buffer state, so its record adopts it in the same write. */
export function adoptMirroredEditorBuffers(
  records: EditorBufferRecords,
  openFiles: readonly OpenFile[]
): EditorBufferRecords {
  let next = records
  for (const file of openFiles) {
    const record = records[file.id]
    if (
      file.mirroredFromRuntimeSession !== true ||
      !record ||
      editorBufferMirrorMismatch(file, record) === null
    ) {
      continue
    }
    next = next === records ? { ...records } : next
    next[file.id] = editorBufferRecordFromFile(file)
  }
  return next
}

/** Moves each migrated tab's record to its new id in the same update that re-keys the tab. */
export function rekeyEditorBuffers(
  records: EditorBufferRecords,
  openFiles: readonly OpenFile[],
  migrations: ReadonlyMap<string, string>,
  patchFor?: (file: OpenFile) => Partial<EditorBufferRecord> | undefined
): EditorBufferRecords {
  const moved = openFiles.filter((file) => migrations.has(file.id))
  if (moved.length === 0) {
    return records
  }
  const next = { ...records }
  // Why two passes: a swap of two ids must not delete the record it just wrote.
  for (const file of moved) {
    delete next[file.id]
  }
  for (const file of moved) {
    next[migrations.get(file.id) ?? file.id] = {
      ...editorBufferOf(records, file),
      ...patchFor?.(file)
    }
  }
  return next
}

/** Keeps records keyed exactly by the open tabs: seeds new tabs, drops closed ones. */
export function reconcileEditorBufferMembership(
  records: EditorBufferRecords,
  openFiles: readonly OpenFile[]
): EditorBufferRecords {
  let next = records
  const ids = new Set<string>()
  for (const file of openFiles) {
    ids.add(file.id)
    if (!Object.hasOwn(next, file.id)) {
      next = next === records ? { ...records } : next
      next[file.id] = editorBufferRecordFromFile(file)
    }
  }
  for (const id of Object.keys(next)) {
    if (!ids.has(id)) {
      next = next === records ? { ...records } : next
      delete next[id]
    }
  }
  return next
}
