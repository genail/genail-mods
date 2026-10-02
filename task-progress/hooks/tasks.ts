import type { Progress, TaskRow, TaskStatus } from '../types'

import { lastProgress } from './protocol'

/** How long a finished row stays in the band. */
export const LINGER_MS = 5000

const FAILED_STATUSES = new Set(['failed', 'killed', 'error'])
const ACTIVE_STATUSES = new Set(['running', 'pending'])

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g
const NOTIFICATION_ID = /<task-id>([^<]+)<\/task-id>/
const NOTIFICATION_STATUS = /<status>([^<]+)<\/status>/
const OUTPUT_FILE = /Output is being written to: (\S+\.output)/

const FILE_ARGS = ['file_path', 'notebook_path', 'path']
const TEXT_ARGS = ['description', 'command', 'pattern', 'url', 'query']

type AgentStatus = { id: string; status: string }

function endStatus(status: string): TaskStatus {
  return FAILED_STATUSES.has(status) ? 'failed' : 'done'
}

/** Applies `change` to the rows it returns a new row for; the same list when none changed. */
function patch(tasks: TaskRow[], change: (task: TaskRow) => TaskRow | null): TaskRow[] {
  let isChanged = false
  const next = tasks.map(task => {
    const changed = change(task)

    if (changed === null) {
      return task
    }

    isChanged = true

    return changed
  })

  return isChanged ? next : tasks
}

function end(task: TaskRow, status: string, now: number): TaskRow {
  return { ...task, status: endStatus(status), endedAt: now }
}

export function addTask(tasks: TaskRow[], task: TaskRow): TaskRow[] {
  return tasks.some(t => t.id === task.id)
    ? tasks.map(t => (t.id === task.id ? task : t))
    : [...tasks, task]
}

export function recordActivity(tasks: TaskRow[], id: string, action: string): TaskRow[] {
  return patch(tasks, task =>
    task.id === id ? { ...task, toolCalls: task.toolCalls + 1, lastAction: action } : null,
  )
}

export function setProgress(tasks: TaskRow[], id: string, progress: Progress): TaskRow[] {
  return patch(tasks, task => (task.id === id ? { ...task, progress } : null))
}

export function finishTask(tasks: TaskRow[], id: string, status: string, now: number): TaskRow[] {
  return patch(tasks, task =>
    task.id === id && task.status === 'running' ? end(task, status, now) : null,
  )
}

export function pruneFinished(tasks: TaskRow[], now: number): TaskRow[] {
  const kept = tasks.filter(task => task.endedAt === undefined || now - task.endedAt < LINGER_MS)

  return kept.length === tasks.length ? tasks : kept
}

/** Finishes the agent rows `$.agent.list()` no longer reports as active. */
export function applyAgentStatuses(
  tasks: TaskRow[],
  agents: readonly AgentStatus[],
  now: number,
): TaskRow[] {
  const statusById = new Map(agents.map(agent => [agent.id, agent.status]))

  return patch(tasks, task => {
    const status = statusById.get(task.id)
    const isOver = task.kind === 'agent' && task.status === 'running' && status !== undefined

    return isOver && !ACTIVE_STATUSES.has(status) ? end(task, status, now) : null
  })
}

/** Finishes the running shells missing from the engine's in-flight list. */
export function settleShells(
  tasks: TaskRow[],
  inFlightIds: readonly string[],
  now: number,
): TaskRow[] {
  const inFlight = new Set(inFlightIds)

  return patch(tasks, task =>
    task.kind === 'shell' && task.status === 'running' && !inFlight.has(task.id)
      ? end(task, 'completed', now)
      : null,
  )
}

export function parseTaskNotifications(text: string): AgentStatus[] {
  return [...text.matchAll(NOTIFICATION)].flatMap(([, body = '']) => {
    const id = NOTIFICATION_ID.exec(body)?.[1]
    const status = NOTIFICATION_STATUS.exec(body)?.[1]

    return id !== undefined && status !== undefined ? [{ id, status }] : []
  })
}

/**
 * What one appended conversation row changes: an agent's own progress line,
 * or a background task's completion notice.
 */
export function applyAppendedRow(
  tasks: TaskRow[],
  appended: { type: string; agentId?: string; text: string },
  now: number,
): TaskRow[] {
  let next = tasks
  const { agentId } = appended

  if (agentId !== undefined && appended.type === 'assistant') {
    const progress = lastProgress(appended.text)

    if (progress !== null) {
      next = setProgress(next, agentId, progress)
    }
  }

  for (const { id, status } of parseTaskNotifications(appended.text)) {
    next = finishTask(next, id, status, now)
  }

  return next
}

export function shellOutputFile(text: string): string | undefined {
  return OUTPUT_FILE.exec(text)?.[1]
}

export function describeAction(tool: string, input: Readonly<Record<string, unknown>>): string {
  for (const key of FILE_ARGS) {
    const value = input[key]

    if (typeof value === 'string' && value !== '') {
      return `${tool} ${value.split('/').pop()}`
    }
  }

  for (const key of TEXT_ARGS) {
    const value = input[key]

    if (typeof value === 'string' && value !== '') {
      return `${tool} ${value.split('\n')[0]}`
    }
  }

  return tool
}

export type ShellRead = { id: string; consumedBytes: number; progress: Progress | null }

export function applyShellRead(tasks: TaskRow[], shellRead: ShellRead): TaskRow[] {
  const { id, consumedBytes, progress } = shellRead

  if (consumedBytes === 0 && progress === null) {
    return tasks
  }

  return patch(tasks, task =>
    task.id === id
      ? {
          ...task,
          readOffset: (task.readOffset ?? 0) + consumedBytes,
          progress: progress ?? task.progress,
        }
      : null,
  )
}
