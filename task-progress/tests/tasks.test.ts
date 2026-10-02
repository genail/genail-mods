import { describe, expect, test } from 'claude-code/testing'

import type { TaskRow } from '../types'
import {
  LINGER_MS,
  addTask,
  applyAgentStatuses,
  applyAppendedRow,
  applyShellRead,
  describeAction,
  finishTask,
  parseTaskNotifications,
  pruneFinished,
  recordActivity,
  setProgress,
  settleShells,
  shellOutputFile,
} from '../hooks/tasks'

const OUTPUT_FILE = '/tmp/claude/project/session/tasks/b8626ysiv.output'

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 's1',
  kind: 'shell',
  name: 'build',
  startedAt: 0,
  status: 'running',
  toolCalls: 0,
  ...over,
})

describe('addTask', () => {
  test('appends a new id', () => {
    expect(addTask([row()], row({ id: 's2' })).map(t => t.id)).toEqual(['s1', 's2'])
  })

  test('replaces an existing id', () => {
    expect(addTask([row()], row({ name: 'again' }))).toEqual([row({ name: 'again' })])
  })
})

describe('recordActivity', () => {
  test('counts the call and keeps the action', () => {
    const tasks = [row({ id: 'a1', kind: 'agent' }), row()]

    expect(recordActivity(tasks, 'a1', 'Read: api.ts')[0]).toEqual(
      row({ id: 'a1', kind: 'agent', toolCalls: 1, lastAction: 'Read: api.ts' }),
    )
  })

  test('returns the same list for an unknown id', () => {
    const tasks = [row()]

    expect(recordActivity(tasks, 'nope', 'Read: x')).toBe(tasks)
  })
})

describe('setProgress', () => {
  test('sets the progress of one row', () => {
    const progress = { kind: 'percent', percent: 10, label: 'x' } as const

    expect(setProgress([row()], 's1', progress)[0]?.progress).toEqual(progress)
  })

  test('returns the same list for an unknown id', () => {
    const tasks = [row()]

    expect(setProgress(tasks, 'nope', { kind: 'unknown', label: '' })).toBe(tasks)
  })
})

describe('finishTask', () => {
  test('marks a completed task done', () => {
    expect(finishTask([row()], 's1', 'completed', 900)[0]).toEqual(
      row({ status: 'done', endedAt: 900 }),
    )
  })

  test('marks a failed or killed task failed', () => {
    expect(finishTask([row()], 's1', 'failed', 900)[0]?.status).toBe('failed')
    expect(finishTask([row()], 's1', 'killed', 900)[0]?.status).toBe('failed')
  })

  test('leaves a finished task alone', () => {
    const tasks = [row({ status: 'done', endedAt: 5 })]

    expect(finishTask(tasks, 's1', 'failed', 900)).toBe(tasks)
  })
})

describe('pruneFinished', () => {
  test('drops rows that lingered long enough and keeps the rest', () => {
    const tasks = [
      row({ id: 'old', status: 'done', endedAt: 0 }),
      row({ id: 'fresh', status: 'failed', endedAt: 1 }),
      row({ id: 'live' }),
    ]

    expect(pruneFinished(tasks, LINGER_MS).map(t => t.id)).toEqual(['fresh', 'live'])
  })

  test('returns the same list when nothing is due', () => {
    const tasks = [row()]

    expect(pruneFinished(tasks, LINGER_MS * 10)).toBe(tasks)
  })
})

describe('applyAgentStatuses', () => {
  test('finishes agents the engine no longer runs', () => {
    const tasks = [
      row({ id: 'a1', kind: 'agent' }),
      row({ id: 'a2', kind: 'agent' }),
      row({ id: 'a3', kind: 'agent' }),
    ]
    const agents = [
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'killed' },
      { id: 'a3', status: 'running' },
    ]

    expect(applyAgentStatuses(tasks, agents, 70).map(t => t.status)).toEqual([
      'done',
      'failed',
      'running',
    ])
  })
})

describe('settleShells', () => {
  test('finishes running shells that are no longer in flight', () => {
    const tasks = [row({ id: 's1' }), row({ id: 's2' }), row({ id: 'a1', kind: 'agent' })]

    expect(settleShells(tasks, ['s2'], 70).map(t => t.status)).toEqual([
      'done',
      'running',
      'running',
    ])
  })
})

describe('parseTaskNotifications', () => {
  test('reads every notification in a row', () => {
    const text = [
      '<task-notification>',
      '<task-id>b8626ysiv</task-id>',
      '<tool-use-id>toolu_011</tool-use-id>',
      `<output-file>${OUTPUT_FILE}</output-file>`,
      '<status>completed</status>',
      '<summary>Background command "x" completed (exit code 0)</summary>',
      '</task-notification>',
      '<task-notification><task-id>a7</task-id><status>failed</status></task-notification>',
    ].join('\n')

    expect(parseTaskNotifications(text)).toEqual([
      { id: 'b8626ysiv', status: 'completed' },
      { id: 'a7', status: 'failed' },
    ])
  })

  test('is empty for other text', () => {
    expect(parseTaskNotifications('hello')).toEqual([])
  })
})

describe('shellOutputFile', () => {
  test('reads the path from the Bash result text', () => {
    const text =
      'Command running in background with ID: b8626ysiv. Output is being written to: ' +
      `${OUTPUT_FILE}. You will be notified when it completes.`

    expect(shellOutputFile(text)).toBe(OUTPUT_FILE)
  })

  test('is undefined without one', () => {
    expect(shellOutputFile('done')).toBeUndefined()
  })
})

describe('describeAction', () => {
  test('names a file by its basename', () => {
    expect(describeAction('Read', { file_path: '/repo/src/api.ts' })).toBe('Read api.ts')
  })

  test('prefers a Bash description over its command', () => {
    expect(describeAction('Bash', { command: 'npm test', description: 'Run tests' })).toBe(
      'Bash Run tests',
    )
    expect(describeAction('Bash', { command: 'npm test' })).toBe('Bash npm test')
  })

  test('falls back to the tool name', () => {
    expect(describeAction('WebFetch', { prompt: 1 })).toBe('WebFetch')
  })
})

describe('applyAppendedRow', () => {
  const agent = row({ id: 'a1', kind: 'agent' })

  test("an agent's progress line sets its progress", () => {
    const appended = { type: 'assistant', agentId: 'a1', text: 'Next.\n::progress::2/5 Reading' }

    expect(applyAppendedRow([agent], appended, 0)[0]?.progress).toEqual({
      kind: 'fraction',
      done: 2,
      total: 5,
      label: 'Reading',
    })
  })

  test('ignores progress lines outside agent loops', () => {
    const tasks = [agent]
    const appended = { type: 'assistant', text: '::progress::2/5 Quoting the format' }

    expect(applyAppendedRow(tasks, appended, 0)).toBe(tasks)
  })

  test("ignores an agent's non-assistant rows", () => {
    const tasks = [agent]
    const appended = { type: 'user', agentId: 'a1', text: '::progress::2/5 tool output' }

    expect(applyAppendedRow(tasks, appended, 0)).toBe(tasks)
  })

  test('a task notification finishes its row', () => {
    const appended = {
      type: 'user',
      text: '<task-notification>\n<task-id>s1</task-id>\n<status>completed</status>\n</task-notification>',
    }

    expect(applyAppendedRow([row()], appended, 900)[0]).toEqual(
      row({ status: 'done', endedAt: 900 }),
    )
  })

  test('returns the same list for an unrelated row', () => {
    const tasks = [row()]

    expect(applyAppendedRow(tasks, { type: 'assistant', text: 'hello' }, 0)).toBe(tasks)
  })
})

describe('applyShellRead', () => {
  test('advances the offset and takes the new progress', () => {
    const progress = { kind: 'fraction', done: 3, total: 10, label: 'Copying' } as const
    const read = { id: 's1', consumedBytes: 25, progress }

    expect(applyShellRead([row({ readOffset: 10 })], read)[0]).toEqual(
      row({ readOffset: 35, progress }),
    )
  })

  test('keeps the last progress when the new lines carry none', () => {
    const progress = { kind: 'unknown', label: 'x' } as const
    const read = { id: 's1', consumedBytes: 4, progress: null }

    expect(applyShellRead([row({ progress })], read)[0]?.progress).toEqual(progress)
  })

  test('returns the same list when nothing new was read', () => {
    const tasks = [row()]

    expect(applyShellRead(tasks, { id: 's1', consumedBytes: 0, progress: null })).toBe(tasks)
  })
})
