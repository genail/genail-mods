import { describe, expect, test } from 'claude-code/testing'

import {
  AGENT_RULE,
  SCRIPT_RULE,
  lastProgress,
  parseProgressLine,
  scanChunk,
} from '../hooks/protocol'

describe('parseProgressLine', () => {
  test('reads a fraction', () => {
    expect(parseProgressLine('::progress::37/120 Migrating users')).toEqual({
      kind: 'fraction',
      done: 37,
      total: 120,
      label: 'Migrating users',
    })
  })

  test('reads a percentage', () => {
    expect(parseProgressLine('::progress::42.5% Uploading')).toEqual({
      kind: 'percent',
      percent: 42.5,
      label: 'Uploading',
    })
  })

  test('reads an unknown total', () => {
    expect(parseProgressLine('::progress::? Indexing repo')).toEqual({
      kind: 'unknown',
      label: 'Indexing repo',
    })
  })

  test('finds the marker after a log prefix', () => {
    expect(parseProgressLine('[12:00:01] INFO ::progress::1/3 step')).toEqual({
      kind: 'fraction',
      done: 1,
      total: 3,
      label: 'step',
    })
  })

  test('takes a line without a label', () => {
    expect(parseProgressLine('::progress::1/3')).toEqual({
      kind: 'fraction',
      done: 1,
      total: 3,
      label: '',
    })
  })

  test('ignores a line without the marker', () => {
    expect(parseProgressLine('progress 1/3')).toBeNull()
  })

  test('rejects a zero total', () => {
    expect(parseProgressLine('::progress::0/0 nothing')).toBeNull()
  })

  test('rejects a malformed value', () => {
    expect(parseProgressLine('::progress::abc')).toBeNull()
  })
})

describe('lastProgress', () => {
  test('the last valid line wins', () => {
    const text = '::progress::1/3 a\nnoise\n::progress::2/3 b\n::progress::bad'

    expect(lastProgress(text)).toEqual({ kind: 'fraction', done: 2, total: 3, label: 'b' })
  })

  test('is null without a progress line', () => {
    expect(lastProgress('just\noutput\n')).toBeNull()
  })
})

describe('scanChunk', () => {
  test('consumes complete lines only', () => {
    const complete = '::progress::1/3 a\n::progress::2/3 b\n'

    expect(scanChunk(`${complete}::progress::3/3 c`)).toEqual({
      progress: { kind: 'fraction', done: 2, total: 3, label: 'b' },
      consumedBytes: complete.length,
    })
  })

  test('counts bytes, not characters', () => {
    expect(scanChunk('żółw\n')).toEqual({ progress: null, consumedBytes: 8 })
  })

  test('consumes nothing before the first newline', () => {
    expect(scanChunk('::progress::1/3 a')).toEqual({ progress: null, consumedBytes: 0 })
  })
})

describe('rules', () => {
  test('both ask for a new total when the work changes', () => {
    for (const rule of [SCRIPT_RULE, AGENT_RULE]) {
      expect(rule).toContain('report the new total')
    }
  })
})
