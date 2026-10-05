import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

function turn(turnId, seq, time, request, reply) {
  return [
    { type: 'turn/start', seq, time, data: { turn: turnId } },
    { type: 'user/message', seq: seq + 1, time: time + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: request }] } },
    { type: 'assistant/message', seq: seq + 2, time: time + 2, data: { message: { content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', seq: seq + 3, time: time + 3, data: { turn: turnId } },
  ]
}

function createHarness() {
  const sessionEvents = new Map([
    ['R', turn(0, 0, 100, 'root', 'root done')],
    ['A', turn(1, 10, 200, 'A one', 'A one done')],
    ['B', turn(1, 10, 210, 'B one', 'B one done')],
    ['W', turn(1, 10, 220, 'worker one', 'worker done')],
    ['R2', turn(0, 0, 100, 'root2', 'root2 done')],
    ['X', turn(1, 10, 200, 'X one', 'X one done')],
  ])
  const headers = [
    { id: 'R', cwd: '/w/one', parentSession: null, seedLength: 0, createdAt: 1 },
    { id: 'A', cwd: '/w/one', parentSession: 'R', seedLength: 4, createdAt: 2 },
    { id: 'B', cwd: '/w/one', parentSession: 'R', seedLength: 4, createdAt: 3 },
    { id: 'Z', cwd: '/w/one', parentSession: 'R', seedLength: 0, createdAt: 5 },
    { id: 'W', cwd: '/w/worker', parentSession: 'R', seedLength: 4, createdAt: 4 },
    { id: 'R2', cwd: '/w/two', parentSession: null, seedLength: 0, createdAt: 1 },
    { id: 'X', cwd: '/w/two', parentSession: 'R2', seedLength: 4, createdAt: 2 },
  ]
  const workspaces = [
    { id: 'w1', path: '/w/one', title: 'one', sessionIds: ['R', 'A', 'B'] },
    { id: 'w2', path: '/w/two', title: 'two', sessionIds: ['R2', 'X'] },
    { id: 'w3', path: '/w/worker', title: 'worker', sessionIds: ['W'] },
  ]
  // Event listeners are COLLECTED per event, not replaced: Cordis keeps every
  // subscriber, and all three planes subscribe to `agent/created`. A one-slot
  // Map would hide two of the three registrations.
  const handlers = new Map()
  const services = new Map()
  // The merged plugin mounts three planes, each of which opens its OWN domain
  // and may register its OWN route. A single-slot mock would let a later plane
  // clobber an earlier one, so both are keyed/collected.
  const routeHandlers = new Map()
  const domains = new Map()
  // Raw Map backing each table, so assertions can inspect persisted records
  // directly (the plugin only sees the KvTable facade).
  const stores = new Map()
  const ctx = {
    sessionQuery: {
      listSessions: async () => headers.map((header) => ({ header })),
      readSession: async (id) => ({ events: sessionEvents.get(id) || [] }),
      readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: id } } })),
    },
    workspaceRegistry: {
      list: () => workspaces,
      resolveByPath: async (path) => workspaces.find((w) => w.path === path) || null,
    },
    storageDomain: {
      open: async (spec) => {
        domains.set(spec.name, spec)
        const tables = {}
        const table = (name) => {
          if (!tables[name]) {
            // Keyed per DOMAIN as well as per table: both the graph and the
            // workflow plane declare overlapping table names, and merging them
            // into one Map would hide a cross-domain write.
            const storeKey = spec.name + '.' + name
            if (!stores.has(storeKey)) stores.set(storeKey, new Map())
            const data = stores.get(storeKey)
            // Also expose the graph plane's bare table names, which is how the
            // upstream suite addresses them.
            if (spec.name === 'session_graph') stores.set(name, data)
            tables[name] = {
              get: (key) => data.get(key),
              entries: () => data.entries(),
              keys: () => data.keys(),
              put: async (key, value) => { data.set(key, structuredClone(value)) },
              delete: async (key) => data.delete(key),
              update: async (key, fn) => { const next = fn(data.get(key)); data.set(key, next); return next },
            }
          }
          return tables[name]
        }
        return { name: spec.name, table, close: async () => {} }
      },
    },
    llm: {
      async *stream(options) {
        const text = options.system
          ? JSON.stringify({ purpose: 'share delta', propositions: [{ claim: 'delta result', ground: { kind: 'produced', evidence: '【1】' } }], negativeConstraints: [], openQuestions: [], deliberateExclusions: [] })
          : '- summary'
        yield { type: 'text-delta', text }
        yield { type: 'finish' }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
    webServer: { register: (spec) => { routeHandlers.set(spec.path, spec.handler); return () => {} } },
    // --- services the two orchestration planes inject ---
    agents: { list: () => [], get: () => null, roots: () => [] },
    sessions: { get: () => null },
    subagents: { listChildren: () => [], list: () => [], getProvider: () => null },
    subprocess: { spawn: () => { throw new Error('subprocess not used in this suite') } },
    effect: (factory) => factory(),
    provide: (name, value) => { services.set(name, value); return () => services.delete(name) },
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {
        const list = handlers.get(name)
        const at = list ? list.indexOf(fn) : -1
        if (at >= 0) list.splice(at, 1)
      }
    },
    config: {},
  }
  apply(ctx, {})

  async function request(method, url, body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method
    req.url = url
    req.socket = { remoteAddress: '127.0.0.1' }
    return await new Promise((resolve) => {
      const res = {
        status: 0,
        writeHead(status) { this.status = status },
        end(text) { resolve({ status: this.status, body: JSON.parse(text) }) },
      }
      // Dispatch by prefix, the way the host router resolves registered routes.
      const path = url.split('?')[0]
      let handler = routeHandlers.get(path)
      if (!handler) {
        for (const [prefix, candidate] of routeHandlers) {
          if (prefix && path.startsWith(prefix)) { handler = candidate; break }
        }
      }
      if (!handler) { resolve({ status: 404, body: { error: 'no-route' } }); return }
      handler(req, res)
    })
  }
  return { request, sessionEvents, handlers, stores, services, routeHandlers, domains }
}

test('host enforces DAG merge, dynamic injection, Git revert, privacy and workspace isolation', async () => {
  const h = createHarness()
  let graph = (await h.request('GET', '/sgx/graph?session=B')).body
  assert.equal(graph.privacy.autoSummary, false)
  assert.equal(graph.privacy.provider, 'mock')
  assert.equal(h.stores.get('commits').size, 0)

  const first = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'A', targetB: 'B' })).body
  assert.equal(first.ok, true)
  assert.deepEqual(first.merge.deltaKeys, ['A:1'])
  const repeated = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'A', targetB: 'B' })).body
  assert.equal(repeated.ok, true)
  assert.equal(repeated.dedup, true)
  assert.equal(repeated.merge.id, first.merge.id)

  const injected = (await h.request('POST', '/sgx/merge/inject', { sessionId: 'B', mergeId: first.merge.id })).body
  assert.equal(injected.ok, true)
  const injectedAgain = (await h.request('POST', '/sgx/merge/inject', { sessionId: 'B', mergeId: first.merge.id })).body
  assert.equal(injectedAgain.dedup, true)

  const uninjected = (await h.request('POST', '/sgx/merge/uninject', { sessionId: 'B', mergeId: first.merge.id })).body
  assert.equal(uninjected.ok, true)
  const uninjectedAgain = (await h.request('POST', '/sgx/merge/uninject', { sessionId: 'B', mergeId: first.merge.id })).body
  assert.equal(uninjectedAgain.dedup, true)
  await h.request('POST', '/sgx/merge/inject', { sessionId: 'B', mergeId: first.merge.id })

  // The merged plugin has three planes, each registering its own prompt
  // section on the agent. The host renders ALL of them, so the harness keeps
  // every section (keyed by name) and concatenates on demand rather than
  // letting the last registration overwrite the first.
  const sections = new Map()
  for (const listener of h.handlers.get('agent/created')) {
    listener({
      agent: {
        session: { id: 'B', header: { cwd: '/w/one' } },
        ctx: {
          systemPrompt: { section: (spec) => { sections.set(spec.name, spec); return () => sections.delete(spec.name) } },
          tools: { register: () => {} },
        },
      },
    })
  }
  const promptText = () => [...sections.values()]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((spec) => (typeof spec.text === 'function' ? spec.text() : spec.text))
    .join('\n')
  assert.match(promptText(), /完整命题、依据与提交原文/)

  const isolated = (await h.request('POST', '/sgx/merge/revert', { sessionId: 'X', mergeId: first.merge.id })).body
  assert.equal(isolated.code, 'workspace-mismatch')

  const reverted = (await h.request('POST', '/sgx/merge/revert', { sessionId: 'B', mergeId: first.merge.id })).body
  assert.equal(reverted.ok, true)
  const revertedAgain = (await h.request('POST', '/sgx/merge/revert', { sessionId: 'B', mergeId: first.merge.id })).body
  assert.equal(revertedAgain.dedup, true)
  assert.doesNotMatch(promptText(), /完整命题、依据与提交原文/)
  graph = (await h.request('GET', '/sgx/graph?session=B')).body
  assert.equal(graph.merges[0].status, 'reverted')
  assert.equal(graph.reverts.length, 1)

  h.sessionEvents.set('A', [...h.sessionEvents.get('A'), ...turn(2, 20, 300, 'A two', 'A two done')])
  for (const eventListener of h.handlers.get('session/event')) {
    for (const event of turn(2, 20, 300, 'A two', 'A two done')) eventListener({ id: 'A' }, event)
  }
  await Promise.resolve()
  const second = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'A', targetB: 'B' })).body
  assert.equal(second.ok, true)
  assert.deepEqual(second.merge.deltaKeys, ['A:2'])

  const enabled = (await h.request('POST', '/sgx/settings', { sessionId: 'B', autoSummary: true })).body
  assert.equal(enabled.autoSummary, true)
  const settings = (await h.request('GET', '/sgx/settings?session=B')).body
  assert.equal(settings.autoSummary, true)

  const purged = (await h.request('POST', '/sgx/purge', { sessionId: 'B', summaries: true, merges: true, settings: true })).body
  assert.equal(purged.ok, true)
  graph = (await h.request('GET', '/sgx/graph?session=B')).body
  assert.equal(graph.merges.length, 0)
  assert.equal(graph.privacy.autoSummary, false)
})

test('concurrent merge requests serialize and reuse one result', async () => {
  const h = createHarness()
  const call = () => h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'A', targetB: 'B' })
  const [left, right] = await Promise.all([call(), call()])
  assert.equal(left.body.ok, true)
  assert.equal(right.body.ok, true)
  assert.equal(left.body.merge.id, right.body.merge.id)
  assert.equal([...h.stores.get('merges').values()].length, 1)
})

test('trusted coordinator spans worktrees, guards managed mutations and commits prepared merges', async () => {
  const h = createHarness()
  const service = h.services.get('sessionGraph')
  assert.equal(service.version, 1)
  const coordinator = service.registerCoordinator({
    resolveMembership: ({ sessionId }) => ['R', 'A', 'B', 'W'].includes(sessionId)
      ? { graphId: 'wf-1', label: 'workflow one', sessionIds: ['R', 'A', 'B', 'W'] }
      : null,
    guardMutation: ({ target }) => target === 'B' ? { allow: false, code: 'manager-approval-required' } : { allow: true },
  })

  const denied = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'W', targetB: 'B' })).body
  assert.deepEqual(denied, { ok: false, code: 'manager-approval-required' })

  const graph = await coordinator.graph('B')
  assert.equal(graph.workspace.key, 'graph:wf-1')
  assert.deepEqual(graph.branches.map((b) => b.id).sort(), ['A', 'B', 'R', 'W'])

  const prepared = await coordinator.prepareMerge({
    callerSessionId: 'B', source: 'W', target: 'B',
    expectedSourceHead: 'W:1', expectedTargetHead: 'B:1', idempotencyKey: 'tx-1',
  })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.preparation.state, 'prepared')
  assert.deepEqual(prepared.preparation.merge.deltaKeys, ['W:1'])

  const committed = await coordinator.commitMerge({ preparationId: prepared.preparation.id })
  assert.equal(committed.ok, true)
  const repeated = await coordinator.commitMerge({ preparationId: prepared.preparation.id })
  assert.equal(repeated.ok, true)
  assert.equal(repeated.dedup, true)
  coordinator.release()
})

test('merging into a target branch with no completed turn is rejected', async () => {
  const h = createHarness()
  const denied = (await h.request('POST', '/sgx/merge', { sessionId: 'Z', sourceA: 'A', targetB: 'Z' })).body
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'target-head-empty')
})
