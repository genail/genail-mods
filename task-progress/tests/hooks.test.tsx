import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { TICK_MS } from '../hooks/format'

const OUTPUT_FILE = '/tmp/session/tasks/b1.output'

const BAND = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** What the engine draws when no plugin draws the band: nothing. */
const emptyBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

const backgroundShell = (on: On) =>
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text:
      'Command running in background with ID: b1. Output is being written to: ' +
      `${OUTPUT_FILE}. You will be notified when it completes.`,
  }))

const spawnedAgent = (on: On) => on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))

/** An Agent tool spawn as the engine raises it. */
const spawnInput = (background: boolean): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  prompt: 'Map the API',
  description: 'Explore API',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background,
  fork: false,
})

/** The band's text as the terminal draws it, one string per Text element. */
async function bandTexts($: Engine): Promise<string[]> {
  const ui = await $.ui.mount(BAND)
  const texts = (await ui.findAll({ type: 'Text' })).map(element => element.text)
  await ui.unmount()

  return texts
}

describe('shells', () => {
  test('a background Bash call draws a row', async ($, on) => {
    mock.clock(on)
    backgroundShell(on)

    await $.tool.call({
      tool: 'Bash',
      command: './migrate.sh',
      description: 'Run migration',
      run_in_background: true,
    })

    expect(await bandTexts($)).toContain('Run migration')
  })

  test('a foreground Bash call draws nothing', async ($, on) => {
    mock.clock(on)
    emptyBand(on)
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: 'ok', stderr: '', interrupted: false },
      text: 'ok',
    }))

    await $.tool.call({ tool: 'Bash', command: 'ls' })

    expect(await bandTexts($)).toEqual([])
  })


  test('each tick reads only the new part of the output file', async ($, on) => {
    const clock = mock.clock(on)
    const firstChunk = '::progress::3/10 Copying\n'
    const chunks = [`${firstChunk}partial`, '']
    const reads: (readonly string[])[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('process.run', ($, e) => {
      reads.push(e.argv)

      return {
        value: {
          exitCode: 0,
          stdout: chunks.shift() ?? '',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })
    backgroundShell(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: './copy.sh', run_in_background: true })

    await clock.advance(TICK_MS)
    await clock.advance(TICK_MS)

    expect(reads).toEqual([
      ['tail', '-c', '+1', OUTPUT_FILE],
      ['tail', '-c', `+${firstChunk.length + 1}`, OUTPUT_FILE],
    ])
    const texts = await bandTexts($)
    expect(texts).toContain('Copying')
    expect(texts.some(text => text.endsWith('3/10'))).toBe(true)
  })
})

describe('agents', () => {
  test('a background spawn carries the rule and draws a row', async ($, on) => {
    let prompt = ''
    mock.clock(on)
    on('agent.spawn', ($, e) => {
      prompt = e.prompt

      return { model: 'm', agentId: 'a1' }
    })

    await $.agent.spawn(spawnInput(true))

    expect(prompt).toContain('Map the API')
    expect(prompt).toContain('::progress::')
    const texts = await bandTexts($)
    expect(texts).toContain('Explore API')
    expect(texts).toContain('▸ 0 tool calls')
  })

  test('a foreground spawn is left alone', async ($, on) => {
    let prompt = ''
    mock.clock(on)
    emptyBand(on)
    on('agent.spawn', ($, e) => {
      prompt = e.prompt

      return { model: 'm', agentId: 'a1' }
    })

    await $.agent.spawn(spawnInput(false))

    expect(prompt).toBe('Map the API')
    expect(await bandTexts($)).toEqual([])
  })
})

describe('prompt', () => {
  test('the system prompt gains the script rule, last', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Hi.', scope: 'shared' }] }))

    const { sections } = await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      tools: [],
      outputStyle: null,
      traits: [],
    })

    expect(sections.at(-1)).toEqual(
      expect.objectContaining({ id: 'task-progress:rule', scope: 'session' }),
    )
  })
})

describe('band', () => {
  test('yields to a survey', async ($, on) => {
    mock.clock(on)
    emptyBand(on)
    spawnedAgent(on)
    await $.agent.spawn(spawnInput(true))

    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })

    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })
})
