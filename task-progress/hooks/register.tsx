import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TaskRow } from '../types'
import { TICK_MS, formatRow, nameCells } from './format'
import { AGENT_RULE, PROGRESS_MARKER, SCRIPT_RULE, scanChunk } from './protocol'
import type { ShellRead } from './tasks'
import {
  addTask,
  applyAgentStatuses,
  applyAppendedRow,
  applyShellRead,
  describeAction,
  pruneFinished,
  recordActivity,
  settleShells,
  shellOutputFile,
} from './tasks'

const tasksAtom = atom({ plugin: 'task-progress', key: 'tasks' } as const, [])
const nowAtom = atom({ plugin: 'task-progress', key: 'now' } as const, 0)

const RULE_SECTION_ID = 'task-progress:rule'
const NOTIFICATION_TAG = '<task-notification>'
const TAIL_TIMEOUT_MS = 5000

/** Room for the collapse control (`[-]`) Claude Code draws at the band's top-right. */
const COLLAPSE_CONTROL_CELLS = 4

const TONE_COLOR = { running: 'cyan', done: 'green', failed: 'red' } as const

/** Writes the tasks only when `change` changes them, so a no-op draws nothing. */
async function changeTasks($: EngineInterface, change: (tasks: TaskRow[]) => TaskRow[]) {
  const tasks = await read($, tasksAtom)

  if (change(tasks) !== tasks) {
    await update($, tasksAtom, change)
  }
}

async function startTask($: EngineInterface, task: Omit<TaskRow, 'startedAt'>) {
  const now = await $.clock.now()

  await changeTasks($, tasks => addTask(tasks, { ...task, startedAt: now }))
  await update($, nowAtom, () => now)
}

async function readShell($: EngineInterface, task: TaskRow): Promise<ShellRead | null> {
  if (task.outputFile === undefined) {
    return null
  }

  const offset = task.readOffset ?? 0
  const { exitCode, stdout } = await $.process.run(
    ['tail', '-c', `+${offset + 1}`, task.outputFile],
    { timeoutMs: TAIL_TIMEOUT_MS },
  )

  return exitCode === 0 ? { id: task.id, ...scanChunk(stdout) } : null
}

async function tick($: EngineInterface) {
  const tasks = await read($, tasksAtom)

  if (tasks.length === 0) {
    return
  }

  const now = await $.clock.now()
  const running = tasks.filter(task => task.status === 'running')
  const shellReads = await Promise.all(
    running.filter(task => task.kind === 'shell').map(task => readShell($, task)),
  )
  const agents = running.some(task => task.kind === 'agent') ? await $.agent.list() : []

  await update($, tasksAtom, current => {
    let next = current

    for (const shellRead of shellReads) {
      next = shellRead === null ? next : applyShellRead(next, shellRead)
    }

    return pruneFinished(applyAgentStatuses(next, agents, now), now)
  })
  await update($, nowAtom, () => now)
}

function textOf(content: readonly { type: string; [field: string]: unknown }[]): string {
  return content
    .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    let isTicking = false
    let lastError = ''

    $.clock.every(TICK_MS, () => {
      if (isTicking) {
        return
      }

      isTicking = true
      tick($)
        .then(
          () => {
            lastError = ''
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)

            if (message !== lastError) {
              lastError = message
              $.ui.log(`task-progress: ${message}`)
            }
          },
        )
        .finally(() => {
          isTicking = false
        })
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)

    return {
      sections: [...sections, { id: RULE_SECTION_ID, text: SCRIPT_RULE, scope: 'session' }],
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const taskId =
      ran.deny === undefined && ran.isError !== true ? ran.result.backgroundTaskId : undefined

    if (taskId !== undefined) {
      await startTask($, {
        id: taskId,
        kind: 'shell',
        name: e.description || e.command.split('\n')[0] || e.command,
        status: 'running',
        toolCalls: 0,
        outputFile: shellOutputFile(ran.text ?? ''),
        readOffset: 0,
      })
    }

    return ran
  })

  on('tool.call', async ($, e, next) => {
    const { agentId } = e

    if (agentId !== undefined) {
      const action = describeAction(String(e.tool), e)

      await changeTasks($, tasks => recordActivity(tasks, agentId, action))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (!e.background) {
      return next(e)
    }

    const spawned = await next({ ...e, prompt: `${e.prompt}\n\n${AGENT_RULE}` })

    if (spawned.agentId !== undefined) {
      await startTask($, {
        id: spawned.agentId,
        kind: 'agent',
        name: e.description || e.subagentType,
        status: 'running',
        toolCalls: 0,
      })
    }

    return spawned
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const text = textOf(e.message.content)

    if (text.includes(PROGRESS_MARKER) || text.includes(NOTIFICATION_TAG)) {
      const now = await $.clock.now()
      const appended = { type: e.message.type, agentId: e.agentId, text }

      await changeTasks($, tasks => applyAppendedRow(tasks, appended, now))
    }

    return stored
  })

  on('classic.Stop', async ($, e, next) => {
    const inFlight = e.background_tasks

    if (inFlight !== undefined) {
      const now = await $.clock.now()
      const ids = inFlight.map(task => task.id)

      await changeTasks($, tasks => settleShells(tasks, ids, now))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const tasks = await read($, tasksAtom)

    if (tasks.length === 0) {
      return next(e)
    }

    const now = await read($, nowAtom)
    const { Box, Text } = $.ui.resolve(e)
    const views = tasks.map(task => formatRow(task, now, e.props.bodyColumns))
    const nameWidth = nameCells(
      views.map(view => view.name),
      e.props.bodyColumns,
    )

    return (
      <Box flexDirection="column" paddingRight={COLLAPSE_CONTROL_CELLS}>
        {views.map(view => (
          <Box key={view.id} gap={1}>
            <Box flexShrink={0}>
              <Text color={TONE_COLOR[view.tone]}>{view.spinner}</Text>
            </Box>
            <Box width={nameWidth} flexShrink={0}>
              <Text wrap="truncate-end">{view.name}</Text>
            </Box>
            {view.meter === '' ? null : (
              <Box flexShrink={0}>
                <Text color={TONE_COLOR[view.tone]}>{view.meter}</Text>
              </Box>
            )}
            {/* The one part that gives way when the row is too wide. */}
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {view.detail}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{view.elapsed}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
