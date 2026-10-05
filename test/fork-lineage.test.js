import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

// Fork lineage regression suite.
//
// DSH used to expose the inherited prefix length as `SessionHeader.seedLength`.
// The session format no longer carries that field: a seeded session has
// `header.isSeeded === true`, and the exact prefix length is published on the
// log observation as the top-level `inheritedEventCount`. `meta.seedLength` is
// not merely unknown -- `SessionStore.prepare` rebuilds the header from a fixed
// field list (so an unknown key is dropped silently, leaving `isSeeded` false),
// and `validateSessionHeader` throws outright on a persisted `seedLength`.
//
// The critical property is that a real fork's `events` array CONTAINS the
// ancestor prefix: the first `inheritedEventCount` events belong to the parent.
// The ancestor's `turn/end` therefore closes a turn inside the child's log too.
// The graph plane must hand those commits back to the ancestor instead of
// counting them as the child's own work. The older suites never caught this
// because their mocks returned a child log stripped of the inherited prefix,
// leaving the reassignment loop with nothing to do.

function turn(turnId, seq, time, request, reply) {
  return [
    { type: 'turn/start', seq, time, data: { turn: turnId } },
    { type: 'user/message', seq: seq + 1, time: time + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: request }] } },
    { type: 'assistant/message', seq: seq + 2, time: time + 2, data: { message: { content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', seq: seq + 3, time: time + 3, data: { turn: turnId } },
  ]
}

// The parent's two completed turns. `end-seed` is appended by the fork builder
// at the cut; it is not itself a turn.
const PARENT = [...turn(0, 0, 100, 'root one', 'root one done'), ...turn(1, 4, 200, 'root two', 'root two done')]
const PREFIX = PARENT.length // 8 events
const SEED_MARKER = { type: 'session/end-seed', seq: PREFIX, time: 210, data: { inherited: true } }

/**
 * Build a fork the way the real host does:
 *   - the child's log starts with the parent's prefix verbatim
 *   - `session/end-seed {inherited:true}` marks the cut at index PREFIX
 *   - the child then appends its own turns at seq >= PREFIX + 1
 * `inheritedEventCount` on the observation equals PREFIX + 1 (the marker is the
 * last inherited event), matching dsh-api-session-controller's
 * `SessionLogOffset(boundary + 1)`.
 */
function createHarness() {
  const childOwn = turn(2, PREFIX + 1, 300, 'child work', 'child work done')
  const childLog = [...PARENT, SEED_MARKER, ...childOwn]

  const sessionEvents = new Map([
    ['R', PARENT],
    ['C', childLog],
  ])
  // Real SessionHeader shape: no `seedLength` anywhere.
  const headers = [
    { id: 'R', cwd: '/w/fork', parentSession: null, isSeeded: false, createdAt: 1 },
    { id: 'C', cwd: '/w/fork', parentSession: 'R', isSeeded: true, createdAt: 2 },
  ]
  const snapshots = new Map([
    ['R', { session: headers[0], inheritedEventCount: 0, events: PARENT }],
    ['C', { session: headers[1], inheritedEventCount: PREFIX + 1, events: childLog }],
  ])
  const workspaces = [{ id: 'w1', path: '/w/fork', title: 'fork', sessionIds: ['R', 'C'] }]

  const handlers = new Map()
  const services = new Map()
  const routeHandlers = new Map()
  const stores = new Map()

  const ctx = {
    sessionQuery: {
      listSessions: async () => headers.map((header) => ({ header, live: null, persisted: null })),
      readSession: async (id) => snapshots.get(id) || { session: {}, inheritedEventCount: 0, events: [] },
      readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: id } } })),
    },
    workspaceRegistry: {
      list: () => workspaces,
      resolveByPath: async (path) => workspaces.find((w) => w.path === path) || null,
    },
    storageDomain: {
      open: async (spec) => {
        const table = (name) => {
          const key = spec.name + '.' + name
          if (!stores.has(key)) stores.set(key, new Map())
          const data = stores.get(key)
          return {
            get: (k) => data.get(k),
            entries: () => data.entries(),
            keys: () => data.keys(),
            put: async (k, v) => { data.set(k, structuredClone(v)) },
            delete: async (k) => data.delete(k),
            update: async (k, fn) => { const next = fn(data.get(k)); data.set(k, next); return next },
          }
        }
        return { name: spec.name, table, close: async () => {} }
      },
    },
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: '- summary' }
        yield { type: 'finish' }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
    webServer: { register: (spec) => { routeHandlers.set(spec.path, spec.handler); return () => {} } },
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
      const path = url.split('?')[0]
      let chosen = routeHandlers.get(path)
      if (!chosen) {
        for (const [prefix, candidate] of routeHandlers) {
          if (prefix && path.startsWith(prefix)) { chosen = candidate; break }
        }
      }
      if (!chosen) { resolve({ status: 404, body: { error: 'no-route' } }); return }
      chosen(req, res)
    })
  }
  return { request, sessionEvents, snapshots, services, PREFIX }
}

test('a fork\'s inherited prefix is credited to the ancestor, not the child', async () => {
  const h = createHarness()
  const graph = (await h.request('GET', '/sgx/graph?session=C')).body

  const c = graph.branches.find((b) => b.id === 'C')
  const r = graph.branches.find((b) => b.id === 'R')
  assert.ok(c && r, 'both branches are present')

  // The child's log physically contains the parent's two turns. Only its OWN
  // turn (seq PREFIX+1 onwards) may be counted as the child's work.
  assert.equal(c.commitCount, 1, 'child owns exactly its own turn')
  assert.equal(r.commitCount, 2, 'parent keeps both of its turns')

  // The two inherited commits must be attributed to R, once each.
  const rCommits = graph.commits.filter((x) => x.sessionId === 'R')
  const cCommits = graph.commits.filter((x) => x.sessionId === 'C')
  assert.equal(rCommits.length, 2)
  assert.equal(cCommits.length, 1)

  // The child still reaches its ancestor: those inherited commits are its
  // chain prefix, so the fork point is visible rather than erased.
  assert.ok(c.chain.length > c.commitCount, 'child chain includes inherited commits')
})

test('a legacy seedLength header does not zero out the fork boundary', async () => {
  const h = createHarness()
  // Simulate a peer that predates the rename: strip the modern field and give
  // the header the old one. The plane must still find the boundary.
  h.snapshots.get('C').inheritedEventCount = undefined
  h.snapshots.get('C').session = { ...h.snapshots.get('C').session, seedLength: h.PREFIX + 1 }

  const graph = (await h.request('GET', '/sgx/graph?session=C')).body
  const c = graph.branches.find((b) => b.id === 'C')
  const r = graph.branches.find((b) => b.id === 'R')
  assert.equal(c.commitCount, 1)
  assert.equal(r.commitCount, 2)
})

test('with no inherited prefix at all the child owns everything in its log', async () => {
  const h = createHarness()
  // Degenerate case: the log is the child's own from seq 0 (an unseeded
  // session, or a fork whose prefix was not published). Nothing may be
  // misattributed to an ancestor that did not contribute it.
  h.snapshots.get('C').inheritedEventCount = 0

  const graph = (await h.request('GET', '/sgx/graph?session=C')).body
  const c = graph.branches.find((b) => b.id === 'C')
  // 3 turns are physically present (2 inherited + 1 own); with a zero prefix
  // the plane treats the whole log as the child's, which is the documented
  // fallback rather than a silent partial credit.
  assert.equal(c.commitCount, 3)
})

test('fork lineage is not read from the removed header field', async () => {
  // Guard against a regression to the old field: a header whose `seedLength` is
  // wrong must not override a correct `inheritedEventCount`.
  const h = createHarness()
  h.snapshots.get('C').session = { ...h.snapshots.get('C').session, seedLength: 999 }
  const graph = (await h.request('GET', '/sgx/graph?session=C')).body
  const c = graph.branches.find((b) => b.id === 'C')
  assert.equal(c.commitCount, 1, 'modern field wins; bogus seedLength ignored')
})
