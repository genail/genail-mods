import type { Progress } from '../types'

export const PROGRESS_MARKER = '::progress::'

const PROGRESS_LINE = /::progress::(?:(\d+)\/(\d+)|(\d+(?:\.\d+)?)%|\?)(?:\s+(.*))?$/

const LINE_BREAK = '\n'

export const SCRIPT_RULE = `# Progress reporting
When you write a script or command that can run longer than about 30 seconds and you run it in the background, make it print progress lines to stderr, at most once per second:
- \`${PROGRESS_MARKER}<done>/<total> <label>\` when the total is known, e.g. \`${PROGRESS_MARKER}37/120 Migrating users\`
- \`${PROGRESS_MARKER}<percent>% <label>\` when only a percentage is known
- \`${PROGRESS_MARKER}? <label>\` when neither is
If you find more or fewer steps than planned, report the new total in the next line.
The user watches these as a live progress bar.`

export const AGENT_RULE = `---
Progress reporting: you run in the background, and the user watches a live progress bar fed by your messages. Each time you start a new step of your work, begin a message with one line \`${PROGRESS_MARKER}<done>/<total> <label>\` (or \`<percent>%\`, or \`?\` when you cannot estimate), e.g. \`${PROGRESS_MARKER}3/8 Reviewing the auth module\`. One line per step, no more. If you find more or fewer steps than planned, report the new total in the next line. Long scripts you run in the background should print the same lines to stderr, at most once per second.`

export function parseProgressLine(line: string): Progress | null {
  const match = PROGRESS_LINE.exec(line.trimEnd())

  if (match === null) {
    return null
  }

  const [, done, total, percent, rawLabel] = match
  const label = (rawLabel ?? '').trim()

  if (done !== undefined && total !== undefined) {
    const totalCount = Number(total)

    return totalCount > 0 ? { kind: 'fraction', done: Number(done), total: totalCount, label } : null
  }

  if (percent !== undefined) {
    return { kind: 'percent', percent: Number(percent), label }
  }

  return { kind: 'unknown', label }
}

export function lastProgress(text: string): Progress | null {
  const lines = text.split(LINE_BREAK)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const progress = parseProgressLine(lines[i] ?? '')

    if (progress !== null) {
      return progress
    }
  }

  return null
}

/**
 * Scans the complete lines of a chunk read from an output file: the last
 * progress among them, and how many bytes they span (the next read's start).
 */
export function scanChunk(chunk: string): { progress: Progress | null; consumedBytes: number } {
  const end = chunk.lastIndexOf(LINE_BREAK)

  if (end === -1) {
    return { progress: null, consumedBytes: 0 }
  }

  const complete = chunk.slice(0, end + 1)

  return {
    progress: lastProgress(complete),
    consumedBytes: new TextEncoder().encode(complete).length,
  }
}
