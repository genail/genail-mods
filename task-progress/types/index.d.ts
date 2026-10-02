export type Progress =
  | { kind: 'fraction'; done: number; total: number; label: string }
  | { kind: 'percent'; percent: number; label: string }
  | { kind: 'unknown'; label: string }

export type TaskKind = 'shell' | 'agent'

export type TaskStatus = 'running' | 'done' | 'failed'

export type TaskRow = {
  id: string
  kind: TaskKind
  name: string
  startedAt: number
  status: TaskStatus
  endedAt?: number
  /** A shell's output file, which the mod tails for progress lines. */
  outputFile?: string
  /** Bytes of `outputFile` already scanned. */
  readOffset?: number
  progress?: Progress
  toolCalls: number
  lastAction?: string
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { tasks: TaskRow[]; now: number }
  }
}
