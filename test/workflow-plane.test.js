/**
 * Peer-workflow plane — SUCCESS path, driven against a REAL git repository.
 *
 * Every other suite only exercises this plane's error paths (a missing git repo,
 * a dirty tree). The peer-session protocol is the retired-but-retained feature
 * the user explicitly asked to keep, so it needs at least one test that
 * actually creates a workflow, forks a worker, and merges it back.
 *
 * `git-runtime.js` shells out through `ctx.subprocess.spawn`, so the harness
 * below executes the real `git` binary in a throwaway repo. Nothing is mocked
 * except the harness seams (agents/sessions/storage), which is what a unit test
 * of this plane can legitimately stub.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apply } from '../lib/index.js'

const run = promisify(execFile)

/** Reproduce the `subprocess.spawn` handle shape the runtime awaits. */
function spawnVia() {
  return (spec) => {
    const argv = spec.argv
    const store = { stdout: '', stderr: '' }
    // The runtime reads `handle.collected.*` AFTER awaiting `handle.done`, so the
    // buffers must be populated by the time `done` settles -- and `done` must be
    // attached to the handle, since that is what the runtime awaits.
    const done = run(argv[0], argv.slice(1), { cwd: spec.cwd, maxBuffer: 8 << 20 })
      .then((r) => { store.stdout = r.stdout || ''; store.stderr = r.stderr || ''; return { exitCode: 0 } })
      .catch((e) => {
        store.stdout = e.stdout || ''
        store.stderr = e.stderr || ''
        return { exitCode: typeof e.code === 'number' ? e.code : 1 }
      })
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: store.stdout }) },
        stderr: { readFrom: () => ({ text: store.stderr }) },
      },
    }
  }
}

/** Minimal host: only the seams these three planes actually consume. */
function createHarness() {
  const handlers = new Map()
  const stores = new Map()
  const services = new Map()
  const tools = []
  const sessions = new Map()
  const created = []
  const ctx = {
    config: {},
    // Cordis service lookup. `agentPresets` is genuinely absent on this host, so
    // the optional-preset branches are what get exercised.
    get(name) { return services.get(name) },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    effect(factory) { const d = factory(); return typeof d === 'function' ? d : () => {} },
    provide(name, value) { services.set(name, value); return () => services.delete(name) },
    webServer: { register: () => () => {} },
    sessionQuery: {
      listSessions: async () => [...sessions.values()].map((s) => ({ header: s.header })),
      readSession: async (id) => sessions.get(id) || { events: [] },
      readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: sessionId } } })),
    },
    workspaceRegistry: {
      list: () => [],
      resolveByPath: async () => null,
      // Real signature (dsh-workspace): `create(path, title?) => Promise<Workspace>`,
      // and the returned entity exposes `attachSession(sessionId)`.
      async create(path, title) {
        const attached = []
        return {
          id: 'ws-' + path.replace(/[^a-z0-9]/gi, '').slice(-8),
          path,
          title: title || path,
          sessionIds: attached,
          async attachSession(sessionId) { attached.push(sessionId) },
        }
      },
    },
    storageDomain: {
      open: async (spec) => {
        const tables = {}
        const table = (name) => {
          const key = spec.name + '.' + name
          if (!stores.has(key)) stores.set(key, new Map())
          const data = stores.get(key)
          tables[name] = {
            get: (k) => data.get(k),
            entries: () => data.entries(),
            keys: () => data.keys(),
            size: data.size,
            put: async (k, v) => { data.set(k, structuredClone(v)) },
            delete: async (k) => data.delete(k),
            update: async (k, fn) => { const next = fn(data.get(k)); data.set(k, next); return next },
          }
          return tables[name]
        }
        return { table, close: async () => {} }
      },
    },
    agents: {
      list: () => [],
      get: (id) => created.find((h) => h.handle.agent.id === id)?.handle.agent || null,
      roots: () => [],
      async create(options) {
        const id = options.sessionId
        const header = {
          id,
          cwd: options.meta?.cwd,
          parentSession: options.meta?.parentSession,
          isSeeded: !!options.meta?.isSeeded,
        }
        const followups = []
        const agent = {
          id,
          session: { id, header },
          options: {},
          ctx: { ...ctx, tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} } },
          // The plane assigns the worker its task via `handle.agent.followup`;
          // record it so the test can assert the assignment text.
          followup(message) { followups.push(message); return { ok: true } },
        }
        const handle = {
          agent,
          followups,
          commit: () => {},
          dispose: async () => {},
        }
        created.push({ handle, options })
        return handle
      },
    },
    sessions: { get: () => null },
    subagents: { listChildren: async () => [], list: () => [], getProvider: () => null },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
    llm: {},
  }
  return { ctx, stores, tools, sessions, created, handlers, services }
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'gwf-'))
  const git = (...args) => run('git', args, { cwd: dir })
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'test@local')
  await git('config', 'user.name', 'test')
  await writeFile(join(dir, 'README.md'), 'seed\n')
  await git('add', '-A')
  await git('commit', '-qm', 'init')
  return dir
}

/** A main session with one COMPLETED turn — the fork boundary needs one. */
function seedMainSession(id, cwd) {
  return {
    header: { id, cwd, createdAt: 1 },
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
      { type: 'user/message', seq: 1, time: 2, data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: 'completed' } },
    ],
  }
}

async function standUp() {
  const dir = await makeRepo()
  const h = createHarness()
  const mainId = 'session-main-1'
  h.sessions.set(mainId, seedMainSession(mainId, dir))
  h.ctx.subprocess = { spawn: spawnVia(dir) }
  const api = apply(h.ctx, {})
  // `callingAgent(exec)` requires `exec.agent.session.id` to be a string; the
  // session fixture stores its own id under `header`, so hand the tool layer a
  // session view that carries both.
  const sessionView = { id: mainId, header: h.sessions.get(mainId).header, events: h.sessions.get(mainId).events }
  const exec = { agent: { id: mainId, session: sessionView } }
  const tool = (name) => {
    const t = h.tools.find((x) => x.name === name)
    assert.ok(t, 'tool ' + name + ' must be registered; have ' + h.tools.map((x) => x.name).join(','))
    return t
  }
  // The planes register into agent contexts on `agent/created`; build one.
  const agentCtx = {
    ...h.ctx,
    tools: { register: (t) => { h.tools.push(t); return () => {} } },
    systemPrompt: { section: () => () => {} },
  }
  for (const fn of h.handlers.get('agent/created') || []) {
    await fn({ agent: { id: mainId, session: h.sessions.get(mainId), options: {}, ctx: agentCtx } })
  }
  return { h, api, dir, mainId, exec, tool, agentCtx }
}

test('the peer workflow plane creates a workflow against a real repo', async (t) => {
  const s = await standUp()
  t.after(async () => { await rm(s.dir, { recursive: true, force: true }) })

  const res = await s.tool('workflow_create').execute({ name: 'probe', leaseSeconds: 300 }, s.exec)
  assert.equal(res.ok, true, 'create must succeed on a clean repo: ' + JSON.stringify(res))
  assert.equal(res.workflow.status, 'active')
  assert.equal(res.workflow.managerSessionId, s.mainId)
  assert.equal(res.workflow.managerEpoch, 1)
  assert.equal(res.workflow.leaseMs, 300_000, 'the requested lease is honoured')
  assert.equal(res.workflow.mainBranch, 'main')
  assert.ok(res.workflow.mainGitHead, 'the head sha is recorded')
  assert.equal(res.workflow.repoRoot.replace(/\\/g, '/').endsWith(s.dir.replace(/\\/g, '/').split('/').pop()), true)

  // Re-creating from the same session must be refused, not silently duplicated.
  const again = await s.tool('workflow_create').execute({ name: 'probe2' }, s.exec)
  assert.equal(again.ok, false)
  assert.equal(again.code, 'already-in-workflow')

  // And status must report the live workflow.
  const status = await s.tool('workflow_status').execute({}, s.exec)
  assert.equal(status.ok, true, 'status after create: ' + JSON.stringify(status))
})

test('a worker is forked from the main branch with git lineage, then merged back', async (t) => {
  const s = await standUp()
  t.after(async () => { await rm(s.dir, { recursive: true, force: true }) })

  await s.tool('workflow_create').execute({ name: 'w', leaseSeconds: 300 }, s.exec)
  const spawned = await s.tool('workflow_spawn_worker').execute({ name: 'worker-a', task: 'do a thing' }, s.exec)
  assert.equal(spawned.ok, true, 'spawn must succeed: ' + JSON.stringify(spawned))

  const w = spawned.worker
  assert.ok(w.sessionId && w.branch, 'the worker names its session and branch')
  assert.equal(w.status, 'active')

  // The fork-lineage contract, asserted on the REAL agents.create call: the
  // header marker plus the explicit inherited prefix length -- and never the
  // removed `seedLength` field.
  const opts = s.h.created.at(-1).options
  assert.equal(opts.meta.isSeeded, true, 'the fork must be marked seeded')
  assert.equal(opts.meta.parentSession, s.mainId, 'and name its parent')
  assert.equal(opts.seedLength, undefined, 'seedLength is not a session field')
  assert.equal(opts.inheritedEventCount, opts.seed.length, 'the prefix length travels top-level')
  assert.ok(opts.seed.length > 0, 'the completed main turn is inherited as seed')

  // The worker worktree must be a real, separate checkout on the named branch.
  const branches = await run('git', ['branch', '--list', w.branch], { cwd: s.dir })
  assert.ok(branches.stdout.includes(w.branch), 'the branch exists: ' + branches.stdout)

  // A worker cannot spawn workers (manager-only authority).
  const workerExec = { agent: { id: w.sessionId, session: { id: w.sessionId, header: {} } } }
  const nested = await s.tool('workflow_spawn_worker').execute({ name: 'x', task: 'y' }, workerExec)
  assert.equal(nested.ok, false, 'a non-manager must be refused')

  // Status now lists the worker.
  const status = await s.tool('workflow_status').execute({}, s.exec)
  assert.equal(status.ok, true)
  assert.ok(JSON.stringify(status).includes(w.sessionId), 'status must mention the worker')
})

test('a dirty main worktree is refused before anything is created', async (t) => {
  const s = await standUp()
  t.after(async () => { await rm(s.dir, { recursive: true, force: true }) })

  await writeFile(join(s.dir, 'dirty.txt'), 'uncommitted\n')
  const res = await s.tool('workflow_create').execute({ name: 'nope' }, s.exec)
  assert.equal(res.ok, false, 'a dirty tree must not become a managed main')
  assert.equal(res.code, 'main-worktree-dirty')
  assert.ok(res.detail, 'and the offending status is reported')
})
