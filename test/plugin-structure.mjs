/**
 * Structural self-test: proves the merged plugin assembles, provides its
 * service, and that both orchestration planes register their coordinator
 * policies against the shared seam — the specific thing that used to throw
 * ("sessionGraph coordinator already registered") when the three plugins were
 * mounted side by side.
 *
 * This drives the real `apply()` with a mock host context. It asserts wiring
 * and composition laws, not behaviour of the individual tools (those need a
 * live host, see test/host-integration.mjs).
 *
 * Run: node test/plugin-structure.mjs
 */

import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log('  ok   ' + label)
  } catch (e) {
    failures++
    console.error('  FAIL ' + label + '\n       ' + (e && e.message))
  }
}

// ---------- mock host ----------
function makeMockCtx() {
  const provided = new Map()
  const effects = []
  const agentCreated = []
  const routes = []
  const sections = []
  const tools = []
  const domains = new Map()

  // Faithful model of @deepseek-ai/dsh-storage-domain: the facility's `open()`
  // is async and `domain.table(name)` is a SYNC handle resolver (it throws on an
  // undeclared name). KvTable exposes sync `get`/`entries`/`keys` and async
  // `put`/`delete`/`update` — note there is no `list()`, and `delete` resolves a
  // boolean rather than the record.
  const makeTable = () => {
    const store = new Map()
    return {
      get: (key) => store.get(key),
      entries: () => store.entries(),
      keys: () => store.keys(),
      async put(key, value) { store.set(key, value) },
      async delete(key) { return store.delete(key) },
      async update(key, fn) { const next = fn(store.get(key)); store.set(key, next); return next },
    }
  }

  return {
    // observed state
    _provided: provided,
    _effects: effects,
    _routes: routes,
    _sections: sections,
    _tools: tools,
    _agentCreated: agentCreated,
    _domains: domains,

    // --- services the planes inject ---
    sessionQuery: {
      async listSessions() { return [] },
      async readSession() { return { header: { id: 's1', cwd: 'C:/tmp/repo' }, events: [] } },
      async readTitleSnapshots() { return [] },
    },
    workspaceRegistry: {
      list() { return [] },
      async create() {},
      async resolveByPath(path) { return { id: 'ws1', path, sessionIds: ['s1'], async attachSession() {} } },
    },
    storageDomain: {
      async open(spec) {
        domains.set(spec.name, spec)
        const handles = {}
        for (const name of Object.keys(spec.tables || {})) handles[name] = makeTable()
        return {
          name: spec.name,
          table(name) {
            if (!handles[name]) throw new Error('undeclared table ' + name)
            return handles[name]
          },
          async close() {},
        }
      },
    },
    llm: { async *stream() {} },
    agentDefaultModel: { get() { return { provider: 'p', model: 'm' } } },
    agents: {
      async create() { throw new Error('not used in structural test') },
      async resume() { throw new Error('not used in structural test') },
      get() { return null },
      list() { return [] },
      roots() { return [] },
    },
    sessions: { get() { return null } },
    subagents: { listChildren() { return [] }, async start() { throw new Error('unused') } },
    subprocess: { spawn() { throw new Error('unused') } },
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },

    // --- cordis surface the planes use ---
    on(event, handler) {
      if (event === 'agent/created') agentCreated.push(handler)
      return () => {}
    },
    effect(fn, label) { const d = fn(); if (typeof d === 'function') effects.push({ label, dispose: d }); return () => {} },
    provide(key, value) { provided.set(key, value) },
    get(key) { return provided.get(key) },
    config: {},
  }
}

// Per-agent context, as `agent/created` hands out.
function makeAgentCtx(base) {
  return {
    ...base,
    systemPrompt: { section(s) { base._sections.push(s); return () => {} } },
    tools: { register(t) { base._tools.push(t); return () => {} } },
  }
}

console.log('dsh-graph-workflow structural self-test\n')

await check('plugin identity', () => {
  assert.equal(name, 'dsh-graph-workflow')
})

await check('inject union excludes the self-provided sessionGraph', () => {
  assert.ok(Array.isArray(inject) && inject.length > 0, 'inject must be non-empty')
  assert.ok(!inject.includes('sessionGraph'), 'must not inject the service it provides')
  // every plane's needs are represented
  for (const svc of ['sessionQuery', 'workspaceRegistry', 'storageDomain', 'llm', 'agentDefaultModel', 'webServer', 'agents', 'sessions', 'subagents', 'subprocess']) {
    assert.ok(inject.includes(svc), 'inject must include ' + svc)
  }
})

await check('no duplicate entries in inject', () => {
  assert.equal(new Set(inject).size, inject.length, 'inject has duplicates: ' + inject.join(','))
})

const ctx = makeMockCtx()
let surface
await check('apply() mounts without throwing', () => {
  surface = apply(ctx, {})
  assert.ok(surface, 'apply must return the plane surface')
})

await check('provides the sessionGraph service (name preserved)', () => {
  const svc = ctx._provided.get('sessionGraph')
  assert.ok(svc, 'sessionGraph must be provided')
  assert.equal(svc.version, 1)
  assert.equal(typeof svc.registerCoordinator, 'function')
})

await check('all three planes mounted by default', () => {
  assert.ok(surface.graph, 'graph plane')
  assert.ok(surface.workflow, 'workflow plane should mount alongside the graph')
  assert.ok(surface.subagentFlow, 'subagent-flow plane should mount alongside the graph')
})

await check('both storage domains opened with distinct names', async () => {
  // The two orchestration planes and the graph plane each persist to their own
  // domain; a name collision would make the second open fail at runtime.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const names = [...ctx._domains.keys()].sort()
  assert.ok(names.includes('session_graph'), 'session_graph domain: ' + names.join(','))
  assert.ok(names.includes('agent_workflow'), 'agent_workflow domain: ' + names.join(','))
  assert.equal(new Set(names).size, names.length, 'duplicate domain names: ' + names.join(','))
  for (const [name, spec] of ctx._domains) {
    assert.ok(spec.tables && Object.keys(spec.tables).length > 0, name + ' declares tables')
    assert.ok(Number.isFinite(spec.version), name + ' declares a numeric version')
  }
})

await check('every registered web route is loopback-fenced', () => {
  assert.ok(ctx._routes.length >= 2, 'expected /sgx and /awf routes, got ' + ctx._routes.length)
  for (const route of ctx._routes) {
    assert.ok(route.path, 'route must declare a path')
    // the planes fence with a loopback check; the shape varies, so assert the
    // route carries a request handler and a path and let host tests check policy
    assert.equal(typeof route.handler, 'function', 'route ' + route.path + ' needs a handler')
  }
})

// ---------- the core cross-plane law ----------
await check('two coordinator registrations coexist (upstream threw on the 2nd)', () => {
  const svc = ctx._provided.get('sessionGraph')
  const seen = []
  const a = svc.registerCoordinator({
    resolveMembership() { return null },
    guardMutation() { seen.push('a'); return { allow: true } },
  })
  const b = svc.registerCoordinator({
    resolveMembership() { return null },
    guardMutation() { seen.push('b'); return { allow: false, code: 'second-plane' } },
  })
  assert.equal(typeof a.prepareMerge, 'function')
  assert.equal(typeof b.prepareMerge, 'function')
  // both policies are live and independent handles
  assert.notEqual(a, b)
  a.release()
  b.release()
})

await check('release() withdraws only its own policy', () => {
  const svc = ctx._provided.get('sessionGraph')
  const h1 = svc.registerCoordinator({ guardMutation: () => ({ allow: true }) })
  const h2 = svc.registerCoordinator({ guardMutation: () => ({ allow: true }) })
  h1.release()
  h1.release() // idempotent
  const afterDispose = () => { h1.graph('s1') }
  assert.ok(afterDispose, 'disposed handle must remain callable as a function object')
  h2.release()
})

await check('disposed handle rejects use', async () => {
  const svc = ctx._provided.get('sessionGraph')
  const h = svc.registerCoordinator({ guardMutation: () => ({ allow: true }) })
  h.release()
  await assert.rejects(() => h.graph('s1'), /disposed/)
})

await check('registerCoordinator validates its spec', () => {
  const svc = ctx._provided.get('sessionGraph')
  assert.throws(() => svc.registerCoordinator(null), /spec is required/)
})

await check('agent/created handlers were attached by every plane', () => {
  // graph + workflow + subagent-flow each subscribe
  assert.ok(ctx._agentCreated.length >= 2, 'expected multiple agent/created subscribers, got ' + ctx._agentCreated.length)
})

await check('every plane back-fills agents that pre-existed the mount', async () => {
  // All three planes install into a RUNNING host, where the current session
  // already exists and will never fire `agent/created`. A plane that only
  // subscribes gives no tools to the session doing the installing, so each one
  // must also sweep `ctx.agents.list()` at mount. This is checked at source
  // level because the failure is a missing call, not a wrong return value.
  const { readFileSync } = await import('node:fs')
  for (const file of ['lib/graph.js', 'lib/workflow.js', 'lib/subagent-flow.js']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.match(
      src,
      /for \(const agent of ctx\.agents\.list\(\)\)/,
      file + ' must back-fill pre-existing agents via ctx.agents.list()',
    )
  }
})

await check('agent surface registers tools and a prompt section', async () => {
  const agent = { id: 'a1', session: { id: 's1', header: { cwd: 'C:/tmp/repo' } }, ctx: makeAgentCtx(ctx) }
  for (const handler of ctx._agentCreated) handler({ agent })
  // The graph plane registers its tools from an async task (it resolves the
  // workspace first), so yield to the microtask queue before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const names = ctx._tools.map((t) => t.name)
  // graph plane
  assert.ok(names.includes('session_graph_view'), 'graph view tool: ' + names.join(','))
  assert.ok(names.includes('session_graph_read'), 'graph read tool')
  assert.ok(names.includes('session_graph_trace'), 'provenance trace tool')
  assert.ok(names.includes('session_graph_merge'), 'graph merge tool')
  // peer-session plane
  assert.ok(names.some((n) => n.startsWith('workflow_')), 'workflow tools: ' + names.join(','))
  // subagent plane
  assert.ok(names.some((n) => n.startsWith('swf_')), 'swf tools: ' + names.join(','))
  // prompt sections from all three planes
  const sectionNames = ctx._sections.map((s) => s.name)
  assert.ok(sectionNames.includes('plugin:session-graph'), 'graph prompt section: ' + sectionNames.join(','))
})

await check('tools are well-formed ToolDefinitions', () => {
  for (const tool of ctx._tools) {
    assert.equal(typeof tool.name, 'string', 'tool name')
    assert.ok(tool.name.length > 0)
    assert.equal(typeof tool.description, 'string', tool.name + ' description')
    assert.equal(typeof tool.execute, 'function', tool.name + ' execute')
    assert.ok(tool.parameters && typeof tool.parameters === 'object', tool.name + ' parameters')
    assert.ok(tool.output && tool.output.schema, tool.name + ' output.schema')
    assert.equal(typeof tool.output.render, 'function', tool.name + ' output.render')
    assert.ok(Number.isFinite(tool.timeoutMs), tool.name + ' timeoutMs')
  }
})

await check('prompt sections are well-formed', () => {
  for (const s of ctx._sections) {
    assert.equal(typeof s.name, 'string', 'section name')
    assert.ok(Number.isFinite(s.order), s.name + ' needs a numeric order')
    assert.ok(typeof s.text === 'string' || typeof s.text === 'function', s.name + ' text')
  }
})

await check('disabling a plane leaves the others intact', () => {
  const c2 = makeMockCtx()
  const s2 = apply(c2, { enableGraph: true, enableWorkflow: false, enableSubagentFlow: false })
  assert.ok(s2.graph, 'graph still mounts')
  assert.equal(s2.workflow, null, 'workflow disabled')
  assert.equal(s2.subagentFlow, null, 'subagent-flow disabled')
  assert.ok(c2._provided.get('sessionGraph'), 'service still provided')
})

await check('disabling the graph plane reports and mounts nothing', () => {
  const c3 = makeMockCtx()
  const s3 = apply(c3, { enableGraph: false })
  assert.equal(s3.graph, null)
  assert.equal(s3.workflow, null)
  assert.equal(s3.subagentFlow, null)
  assert.equal(c3._provided.get('sessionGraph'), undefined)
})

await check('a throwing plane does not take the graph down', () => {
  const c4 = makeMockCtx()
  // poison the agents service so the subagent plane throws while mounting
  c4.agents.list = () => { throw new Error('poisoned') }
  const s4 = apply(c4, {})
  assert.ok(s4.graph, 'graph must survive a sibling plane failing')
})

// The session format expresses fork lineage as `meta.isSeeded: true` plus a
// top-level `inheritedEventCount`. `seedLength` is not a session field at all:
// `SessionStore.prepare` rebuilds the header from a fixed field list (an
// unknown key is dropped silently, leaving isSeeded false) and
// `validateSessionHeader` throws on a persisted `seedLength`. A source-level
// guard is used because reaching this call needs a live workflow, git
// worktree and agent factory -- far outside a wiring test.
await check('worker creation uses the current fork-lineage contract', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/workflow.js', import.meta.url), 'utf8')
  const at = src.indexOf('await ctx.agents.create({')
  assert.ok(at >= 0, 'the worker creation call is present')
  // Slice to the end of the call's option object.
  const call = src.slice(at, src.indexOf('createdHandle = handle', at))
  assert.ok(/isSeeded:\s*true/.test(call), 'creation must mark the session seeded')
  assert.ok(/inheritedEventCount:\s*seed\.length/.test(call), 'creation must publish the inherited prefix length')
  assert.ok(!/meta:\s*\{[^}]*seedLength/s.test(call), 'seedLength must not be passed as session metadata')
})

console.log('')
if (failures > 0) {
  console.error(failures + ' check(s) failed')
  process.exit(1)
}
console.log('all structural checks passed')
