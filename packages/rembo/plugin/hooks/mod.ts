import type { EngineInterface, Register } from 'claude-code'

// rembo's interactive layer: /rembo, the status line, toasts and per-session
// off. Memory itself does not depend on this module (MCP server + hooks).

/** Claude Code versions this module is known to work with; outside them it stays inert. */
const MIN = [2, 1, 287]
const BELOW = [2, 2, 0]
const TOOLS = /^mcp__plugin_rembo_rembo__/
const HELP = [
  '/rembo on        use rembo memory in this session (loads the snapshot)',
  '/rembo off       stop using rembo in this session',
  '/rembo status    hub, device, entries, last sync',
  '/rembo sync      sync now',
  '/rembo search <query>',
  '/rembo forget <id>',
].join('\n')

type App = { node: string; home: string; version: string }
type Status = { ok?: boolean; pending?: number; error?: string }
type State = { app?: App; off: boolean }

function version(v: string): number[] {
  return v.split(/[.-]/).slice(0, 3).map(Number)
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

async function readJson<T>($: EngineInterface, file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(file)) as T
  } catch {
    return undefined
  }
}

async function showStatus($: EngineInterface, state: State): Promise<void> {
  if (!state.app) return
  if (state.off) return $.ui.status('Rembo Mode Off')
  const s = await readJson<Status>($, `${state.app.home}/status.json`)
  const mark = !s ? '…' : s.error === 'unreachable' ? 'offline' : !s.ok ? '!' : s.pending ? `↑${s.pending}` : '✓'
  $.ui.status(`Rembo Mode On · ${mark}`)
}

/** Runs the rembo CLI copy that ships with this plugin. */
async function runCli($: EngineInterface, app: App, args: string[]): Promise<string> {
  const r = await $.process.run([app.node, `${$.plugin.root}/cli.js`, ...args, '--home', app.home], { timeoutMs: 60_000 })
  return r.stdout.trim() || r.stderr.trim() || `rembo exited with ${r.exitCode}`
}

export const register: Register = on => {
  const state: State = { off: false }

  on('session.start', async ($, e, next) => {
    try {
      const running = (await $.session.version()).version
      if (compare(version(running), MIN) < 0 || compare(version(running), BELOW) >= 0) {
        $.ui.log(`rembo: Claude Code ${running} is outside the range this module was tested with; /rembo is off, memory still works.`)
        return next(e)
      }
      state.app = await readJson<App>($, `${$.plugin.root}/app.json`)
      if (!state.app) return next(e)
      const flag = ((await $.env.get('REMBO')) ?? '').toLowerCase()
      const config = await readJson<{ defaults?: { mode?: string } }>($, `${state.app.home}/config.json`)
      state.off = flag === 'off' || (flag !== 'on' && config?.defaults?.mode === 'off')
      await $.command.register({
        name: 'rembo',
        description: 'rembo memory: on, off, status, sync, search, forget',
        argumentHint: 'on | off | status | sync | search <query> | forget <id>',
        immediate: true,
      })
      await showStatus($, state)
      $.clock.every(30_000, () => void showStatus($, state))
    } catch (err) {
      state.app = undefined
      $.ui.log(`rembo: the /rembo module is disabled (${String(err)}); memory still works.`)
    }
    return next(e)
  })

  on('command.run', { command: 'rembo' }, async ($, e) => {
    const app = state.app
    if (!app) return { text: 'rembo is not set up on this machine. In a terminal: npx rembo@latest setup <account-key>' }
    const [sub = 'help', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (sub) {
      case 'off':
        state.off = true
        await showStatus($, state)
        return { text: 'Rembo Mode Off: rembo tools are disabled in this session. Memory loaded at session start stays until /clear.' }
      case 'on': {
        state.off = false
        await showStatus($, state)
        const snapshot = await runCli($, app, ['snapshot', '--cwd', await $.session.cwd()])
        return { text: 'Rembo Mode On: memory is available in this session.', context: snapshot.startsWith('<rembo-memory>') ? [snapshot] : [] }
      }
      case 'status':
        return { text: await runCli($, app, ['status']) }
      case 'sync': {
        const text = await runCli($, app, ['sync'])
        await showStatus($, state)
        return { text }
      }
      case 'search':
        return { text: rest.length ? await runCli($, app, ['search', ...rest]) : 'Usage: /rembo search <query>' }
      case 'forget':
        return { text: rest[0] ? await runCli($, app, ['forget', rest[0]]) : 'Usage: /rembo forget <id>' }
      default:
        return { text: HELP }
    }
  })

  on('tool.call', { tool: TOOLS }, async ($, e, next) => {
    if (state.app && state.off) return { deny: 'rembo is off in this session; the user can turn it on with /rembo on.' }
    const result = await next(e)
    if (state.app && e.tool.endsWith('__remember') && result.deny === undefined && result.isError !== true) {
      $.ui.toast(`Remembered: ${String((e as { title?: unknown }).title ?? '').slice(0, 60)}`)
      void showStatus($, state)
    }
    return result
  })
}
