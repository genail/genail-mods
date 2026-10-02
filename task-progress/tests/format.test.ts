import { describe, expect, test } from 'claude-code/testing'

import type { TaskRow } from '../types'
import { formatElapsed, formatRow, nameCells, renderBar } from '../hooks/format'

const WIDE = 120
const NARROW = 50

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 's1',
  kind: 'shell',
  name: 'migrate.sh',
  startedAt: 0,
  status: 'running',
  toolCalls: 0,
  ...over,
})

describe('formatElapsed', () => {
  test('minutes and seconds', () => {
    expect(formatElapsed(40_000)).toBe('0m40s')
    expect(formatElapsed(72_000)).toBe('1m12s')
  })

  test('hours and minutes past an hour', () => {
    expect(formatElapsed(3_780_000)).toBe('1h03m')
  })

  test('never negative', () => {
    expect(formatElapsed(-5)).toBe('0m00s')
  })
})

describe('renderBar', () => {
  test('fills by fraction', () => {
    expect(renderBar(0.5, 10)).toBe('█████░░░░░')
  })

  test('clamps out-of-range fractions', () => {
    expect(renderBar(1.7, 4)).toBe('████')
    expect(renderBar(-1, 4)).toBe('░░░░')
  })
})

describe('formatRow', () => {
  test('a fraction shows a bar, the count and the label', () => {
    const view = formatRow(
      row({ progress: { kind: 'fraction', done: 37, total: 120, label: 'Migrating users' } }),
      72_000,
      WIDE,
    )

    expect(view.meter).toMatch(/^█+░+ 37\/120$/)
    expect(view.detail).toBe('Migrating users')
    expect(view.elapsed).toBe('1m12s')
    expect(view.tone).toBe('running')
  })

  test('a percentage shows a bar and the percent', () => {
    const view = formatRow(
      row({ progress: { kind: 'percent', percent: 42, label: 'Uploading' } }),
      0,
      WIDE,
    )

    expect(view.meter).toMatch(/^█+░+ 42%$/)
  })

  test('an unknown total shows the label alone', () => {
    const view = formatRow(row({ progress: { kind: 'unknown', label: 'Indexing' } }), 0, WIDE)

    expect(view.meter).toBe('')
    expect(view.detail).toBe('Indexing')
  })

  test('an agent without progress shows its activity', () => {
    const view = formatRow(
      row({ kind: 'agent', name: 'Explore', toolCalls: 4, lastAction: 'Read api.ts' }),
      0,
      WIDE,
    )

    expect(view.meter).toBe('▸ 4 tool calls')
    expect(view.detail).toBe('Read api.ts')
  })

  test('a finished task says how it ended and stops its clock', () => {
    const view = formatRow(row({ status: 'failed', endedAt: 30_000 }), 90_000, WIDE)

    expect(view.meter).toBe('failed')
    expect(view.tone).toBe('failed')
    expect(view.elapsed).toBe('0m30s')
  })

  test('a narrow band gets a shorter bar', () => {
    const progress = { kind: 'fraction', done: 1, total: 2, label: '' } as const
    const barOf = (columns: number) =>
      formatRow(row({ progress }), 0, columns).meter.split(' ')[0]?.length ?? 0

    expect(barOf(NARROW)).toBeLessThan(barOf(WIDE))
  })

  test('the spinner moves with time while running', () => {
    expect(formatRow(row(), 0, WIDE).spinner).not.toBe(formatRow(row(), 500, WIDE).spinner)
  })
})

describe('nameCells', () => {
  const LONG = 'Start worktree dev server on port 3508'

  test('fits the longest name when the band is wide enough', () => {
    expect(nameCells([LONG, 'build'], WIDE)).toBe(LONG.length)
  })

  test('fits short names exactly', () => {
    expect(nameCells(['build', 'Explore API'], WIDE)).toBe('Explore API'.length)
  })

  test('caps the column on a narrow band', () => {
    expect(nameCells([LONG], NARROW)).toBe(20)
  })
})
