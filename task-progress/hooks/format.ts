import type { TaskRow, TaskStatus } from '../types'

/** The band's refresh period; the spinner moves one frame per tick. */
export const TICK_MS = 500

const SPINNER = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']
const FINISHED_MARK = '•'
const BAR_FULL = '█'
const BAR_EMPTY = '░'
const WIDE_BAR_CELLS = 20
const NARROW_BAR_CELLS = 10
const NARROW_COLUMNS = 80
/** The most of the band's width the name column may take. */
const NAME_MAX_SHARE = 0.4

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

export type RowView = {
  id: string
  spinner: string
  name: string
  meter: string
  detail: string
  elapsed: string
  tone: TaskStatus
}

const twoDigits = (n: number) => String(n).padStart(2, '0')

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  const hours = Math.floor(seconds / SECONDS_PER_HOUR)
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)

  return hours > 0
    ? `${hours}h${twoDigits(minutes % SECONDS_PER_MINUTE)}m`
    : `${minutes}m${twoDigits(seconds % SECONDS_PER_MINUTE)}s`
}

/** The name column's width: the longest name, capped to a share of the band. */
export function nameCells(names: readonly string[], columns: number): number {
  const longest = Math.max(1, ...names.map(name => name.length))

  return Math.max(1, Math.min(longest, Math.floor(columns * NAME_MAX_SHARE)))
}

export function renderBar(fraction: number, cells: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells)

  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(cells - filled)
}

function meterOf(task: TaskRow, barCells: number): string {
  const { progress } = task

  if (task.status !== 'running') {
    return task.status
  }

  if (progress?.kind === 'fraction') {
    return `${renderBar(progress.done / progress.total, barCells)} ${progress.done}/${progress.total}`
  }

  if (progress?.kind === 'percent') {
    return `${renderBar(progress.percent / 100, barCells)} ${Math.round(progress.percent)}%`
  }

  if (progress === undefined && task.kind === 'agent') {
    return `▸ ${task.toolCalls} tool calls`
  }

  return ''
}

export function formatRow(task: TaskRow, now: number, columns: number): RowView {
  const barCells = columns < NARROW_COLUMNS ? NARROW_BAR_CELLS : WIDE_BAR_CELLS
  const isRunning = task.status === 'running'

  return {
    id: task.id,
    spinner: isRunning ? (SPINNER[Math.floor(now / TICK_MS) % SPINNER.length] ?? '') : FINISHED_MARK,
    name: task.name,
    meter: meterOf(task, barCells),
    detail: task.progress?.label || task.lastAction || '',
    elapsed: formatElapsed((task.endedAt ?? now) - task.startedAt),
    tone: task.status,
  }
}
