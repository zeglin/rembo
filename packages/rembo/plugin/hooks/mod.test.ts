import { expect, test } from 'claude-code/testing'

const SEARCH = 'mcp__plugin_rembo_rembo__search'
const REMEMBER = 'mcp__plugin_rembo_rembo__remember'

type Seen = { status: (string | undefined)[]; toasts: string[]; runs: string[][]; commands: string[] }

/** Hooks standing for the engine beneath the module. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1], opts: { version?: string; rembo?: string; mode?: string } = {}): Seen {
  const seen: Seen = { status: [], toasts: [], runs: [], commands: [] }
  const files: Record<string, string> = {
    'app.json': JSON.stringify({ node: 'node', home: '/home/u/.rembo', version: '0.1.0' }),
    'config.json': JSON.stringify({ defaults: { mode: opts.mode ?? 'on' } }),
    'status.json': JSON.stringify({ ok: true, pending: 0 }),
  }
  on('session.version', () => ({ value: { version: opts.version ?? '2.1.306' } }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'REMBO' ? opts.rembo : undefined }))
  on('fs.read', (_, e) => {
    const name = Object.keys(files).find(f => e.path.endsWith(f))
    if (!name) throw new Error(`ENOENT ${e.path}`)
    return { value: files[name]! }
  })
  on('command.register', (_, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    seen.runs.push([...e.argv])
    const stdout = e.argv.includes('snapshot') ? '<rembo-memory>\nmemory\n</rembo-memory>' : 'ok'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: { content: [] } }))
  return seen
}

test('registers /rembo and shows the mode with the sync state', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  expect(seen.commands).toContain('rembo')
  expect(seen.status.at(-1)).toBe('Rembo Mode On · ✓')
})

test('/rembo off blocks the rembo tools; /rembo on brings memory back as context', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })

  const offAnswer = await $.command.run({ command: 'rembo', args: 'off' })
  expect(offAnswer.text).toMatch(/Rembo Mode Off/)
  expect(seen.status.at(-1)).toBe('Rembo Mode Off')
  const blocked = await $.tool.call({ tool: SEARCH, query: 'x' })
  expect(blocked.isError ?? blocked.deny !== undefined).toBeTruthy()

  const onAnswer = await $.command.run({ command: 'rembo', args: 'on' })
  expect(onAnswer.context?.[0]).toMatch(/^<rembo-memory>/)
  expect(seen.runs.at(-1)).toContain('snapshot')
  const allowed = await $.tool.call({ tool: SEARCH, query: 'x' })
  expect(allowed.isError).toBeUndefined()
})

test('REMBO=off at launch starts the session off', async ($, on) => {
  const seen = engine(on, { rembo: 'off' })
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  expect(seen.status.at(-1)).toBe('Rembo Mode Off')
})

test('a remembered fact shows a toast', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: REMEMBER, title: 'Build server is box-42' })
  expect(seen.toasts).toContain('Remembered: Build server is box-42')
})

test('outside the tested Claude Code range the module stays inert', async ($, on) => {
  const seen = engine(on, { version: '2.2.0' })
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  expect(seen.commands).toEqual([])
  expect(seen.status).toEqual([])
})
