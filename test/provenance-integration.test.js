import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

/**
 * Behavioural coverage for the provenance enhancement, driven through the REAL
 * plugin: `apply()` against a mock host, then a live merge whose extraction LLM
 * cites its evidence, then the three read surfaces that expose the chain.
 *
 * `provenance-core.test.js` proves the pure functions are correct. This suite
 * proves the plugin actually *wires* them: that a stored merge carries a
 * resolvable chain, that a fabricated citation degrades visibly rather than
 * silently, and that `session_graph_trace` answers both directions.
 */

/**
 * Workspaces and logs are built PER HARNESS under a unique path.
 *
 * This is not cosmetic: the graph plane caches a loaded project by workspace
 * path for `cacheTtlMs`, so two harnesses sharing one path would let the second
 * one read the first one's cached project. Distinct paths also exercise that the
 * cache is keyed by workspace.
 */
function workspacePath(tag) {
  return 'C:/repo-' + tag
}

function turn(turnId, seq, time, request, reply) {
  return [
    { type: 'turn/start', seq, time, data: { turn: turnId } },
    { type: 'user/message', seq: seq + 1, time: time + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: request }] } },
    { type: 'assistant/message', seq: seq + 2, time: time + 2, data: { message: { content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', seq: seq + 3, time: time + 3, data: { turn: turnId } },
  ]
}

function makeFixture(tag) {
  const path = workspacePath(tag)
  const sessions = [`R@${tag}`, `A@${tag}`, `B@${tag}`]
  const events = new Map([
    [sessions[0], turn(0, 0, 100, 'root request that is long enough', 'root done')],
    [sessions[1], turn(1, 10, 200, 'alpha request that is definitely long enough', 'alpha reply')],
    [sessions[2], turn(1, 10, 210, 'beta request that is definitely long enough', 'beta reply')],
  ])
  const headers = [
    { id: sessions[0], cwd: path, parentSession: null, seedLength: 0, createdAt: 1 },
    { id: sessions[1], cwd: path, parentSession: sessions[0], seedLength: 4, createdAt: 2 },
    { id: sessions[2], cwd: path, parentSession: sessions[0], seedLength: 4, createdAt: 3 },
  ]
  const workspaces = [{ id: 'w-' + tag, path, title: tag, sessionIds: sessions }]
  return { path, sessions, events, headers, workspaces }
}

/**
 * Mock host. `citation` controls what the extractor LLM claims to cite, which is
 * how we exercise the resolution paths end to end.
 */
function createHarness(citation, tag = 'a', allCited = false) {
  const fx = makeFixture(tag)
  const { headers, events } = fx
  const routeHandlers = new Map()
  const handlers = new Map()
  const services = new Map()
  const domains = new Map()
  const stores = new Map()
  const tools = []
  const sections = []
  const disposers = []

  const ctx = {
    sessionQuery: {
      listSessions: async () => headers.map((h) => ({ header: h })),
      readSession: async (id) => ({ events: events.get(id) || [] }),
      readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: id } } })),
    },
    workspaceRegistry: {
      list: () => fx.workspaces,
      resolveByPath: async (p) => fx.workspaces.find((w) => w.path === p) || null,
    },
    storageDomain: {
      open: async (spec) => {
        domains.set(spec.name, spec)
        const tables = {}
        const table = (n) => {
          if (!tables[n]) {
            const key = spec.name + '.' + n
            if (!stores.has(key)) stores.set(key, new Map())
            const data = stores.get(key)
            if (spec.name === 'session_graph') stores.set(n, data)
            tables[n] = {
              get: (k) => data.get(k),
              entries: () => data.entries(),
              keys: () => data.keys(),
              put: async (k, v) => { data.set(k, structuredClone(v)) },
              delete: async (k) => data.delete(k),
              update: async (k, fn) => { const next = fn(data.get(k)); data.set(k, next); return next },
            }
          }
          return tables[n]
        }
        return { name: spec.name, table, close: async () => {} }
      },
    },
    llm: {
      async *stream(options) {
        // The extraction request carries a system prompt; the summarizer does not.
        // `allCited` decides whether EVERY claim cites the evidence, which is
        // what separates "chain fully verified" from "some claims fell back".
        const text = options.system
          ? JSON.stringify({
            purpose: 'delta result',
            propositions: [
              { claim: 'alpha produced a delta', ground: { kind: 'observed', evidence: citation } },
              allCited
                ? { claim: 'the delta is reusable', ground: { kind: 'inferred', evidence: citation } }
                : { claim: 'the delta is reusable', ground: { kind: 'inferred' } },
            ],
            negativeConstraints: [
              { claim: 'do not assume beta is empty', ground: { kind: 'assumed', evidence: citation } },
            ],
            openQuestions: [],
            deliberateExclusions: [],
          })
          : '- summary'
        yield { type: 'text-delta', text }
        yield { type: 'finish' }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
    webServer: { register: (spec) => { routeHandlers.set(spec.path, spec.handler); return () => {} } },
    agents: { list: () => [], get: () => null, roots: () => [] },
    sessions: { get: () => null },
    subagents: { listChildren: async () => [], list: () => [], getProvider: () => null },
    subprocess: { spawn: () => { throw new Error('subprocess unused') } },
    effect: (fn, label) => { const d = fn(); if (typeof d === 'function') disposers.push({ label, d }); return () => {} },
    provide: (n, v) => { services.set(n, v); return () => services.delete(n) },
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    config: {},
  }

  return {
    ctx, tools, sections, routeHandlers, handlers, services, stores, fixture: fx,
    /** Build the agent ctx and fire `agent/created`, as the host does. */
    async createAgent(sessionId) {
      const agentCtx = {
        ...ctx,
        systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
        tools: { register: (t) => { tools.push(t); return () => {} } },
      }
      // The graph plane gates tool registration on `session.header.cwd`, so the
      // mock must carry it exactly as the host does.
      const agent = {
        id: sessionId,
        session: { id: sessionId, header: { cwd: fx.path } },
        options: {},
        ctx: agentCtx,
      }
      for (const fn of handlers.get('agent/created') || []) await fn({ agent })
      // The graph plane registers its tools from an async task (it resolves the
      // workspace first), so let that microtask chain settle.
      await new Promise((r) => setTimeout(r, 0))
      return agent
    },
    tool(name) {
      const t = tools.find((x) => x.name === name)
      assert.ok(t, 'tool ' + name + ' must be registered; have: ' + tools.map((x) => x.name).join(', '))
      return t
    },
    /**
     * Render one registered prompt section. Section text is declared as a
     * function of live project state, exactly as it is at prompt-composition
     * time, so calling it is what a real turn would see.
     */
    sectionText(name) {
      const s = sections.filter((x) => x.name === name).pop()
      assert.ok(s, 'section ' + name + ' must be registered; have: ' + sections.map((x) => x.name).join(', '))
      return typeof s.text === 'function' ? s.text() : s.text
    },
  }
}

async function request(h, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  return await new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(s) { this.status = s },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }) },
    }
    const path = url.split('?')[0]
    let handler = h.routeHandlers.get(path)
    if (!handler) for (const [p, c] of h.routeHandlers) if (p && path.startsWith(p)) { handler = c; break }
    assert.ok(handler, 'no route for ' + path)
    handler(req, res)
  })
}

/**
 * Stand up one plugin instance over a fresh fixture and merge `source` into
 * `target`. Each call gets its own tag so the module-level project cache and the
 * provided service cannot leak between tests.
 */
let seq = 0
async function standUp(opts = {}) {
  const tag = opts.tag || String.fromCharCode(97 + (seq++ % 26)) + seq
  const h = createHarness(opts.citation === undefined ? '【1】' : opts.citation, tag, opts.allCited)
  const { apply } = await import('../lib/index.js')
  // Keep the plane handle: it exposes the live project, which is what the read
  // surfaces actually consult.
  const api = apply(h.ctx, opts.config || {})
  const fx = h.fixture
  const [R, A, B] = fx.sessions
  const agent = await h.createAgent(B)
  const exec = { agent: { session: { id: B } } }
  const merged = (await request(h, 'POST', '/sgx/merge', { sessionId: B, sourceA: A, targetB: B })).body
  assert.equal(merged.ok, true, 'merge must succeed: ' + JSON.stringify(merged))
  const key = 'mg:' + merged.merge.id
  const commitKey = A + ':1'
  return { h, api, fx, R, A, B, exec, merged, key, commitKey }
}

test('an exact citation is stored as a resolvable chain, not free text', async () => {
  const t = await standUp({ allCited: true })
  const io = [...t.h.stores.get('merges').values()][0].io
  const p0 = io.propositions[0]

  assert.equal(p0.ground.evidence, '【1】', 'legacy field must survive for old readers')
  assert.ok(p0.ground.provenance, 'a structured chain must be attached')
  assert.equal(p0.ground.provenance.resolution, 'exact', 'citation 1 is in range')
  assert.equal(p0.ground.provenance.commitKey, t.commitKey, 'must name the cited commit')
  assert.equal(p0.ground.provenance.sessionId, t.A)
  assert.equal(p0.ground.provenance.turn, 1)
  // The locator is the whole point: it must point back into the source log.
  // Turn 1 of the source starts at seq 10, so the user message is seq 11.
  assert.equal(p0.ground.provenance.locator.userSeq, 11)
  assert.equal(p0.ground.provenance.locator.endSeq, 13, 'locator must span the whole turn')
  assert.equal(p0.ground.provenance.quote, 'alpha request that is definitely long enough')

  assert.ok(io.sourceIndex.length >= 1, 'the full input list must be recorded')
  assert.equal(io.sourceIndex[0].commitKey, t.commitKey)
  assert.equal(io.sourceIndex[0].locator.userSeq, 11, 'index entries carry locators too')
})

test('a fabricated citation degrades visibly instead of silently resolving', async () => {
  // Only one commit was supplied, so 【9】 cannot refer to anything.
  const t = await standUp({ citation: '【9】', allCited: true })
  const io = [...t.h.stores.get('merges').values()][0].io
  const p0 = io.propositions[0]

  // Never fabricate: it degrades, and it RECORDS what was claimed so the bad
  // citation can be diagnosed rather than lost.
  assert.equal(p0.ground.provenance.resolution, 'derived')
  assert.equal(p0.ground.provenance.cited, 9, 'the impossible citation must be preserved')
  assert.equal(p0.ground.provenance.commitKey, t.commitKey, 'a derived chain still names a real commit')

  const traced = await t.h.tool('session_graph_trace').execute({ target: t.key }, t.exec)
  // The `allCited` fixture emits 【9】 on 2 of 3 claims, so those degrade.
  assert.equal(traced.health.derived, 2, 'both cited claims degrade: ' + JSON.stringify(traced.health))
  assert.equal(traced.health.exact, 0)
  assert.equal(traced.health.ratio, 0)
})

test('the injected prompt warns the reading model about weak chains', async () => {
  const t = await standUp({ citation: '【9】', allCited: true })
  await request(t.h, 'POST', '/sgx/merge/inject', { sessionId: t.B, mergeId: t.merged.merge.id })

  // Section text is a live function of project state, as at prompt-composition time.
  const text = t.h.sectionText('plugin:session-graph')
  assert.match(text, /溯源链/, 'the injected entry must describe chain completeness')
  assert.match(text, /位置回退/, 'and must call out the fallback entries')
  assert.match(text, /session_graph_read/, 'the reader must be told how to expand the chain')
})

test('a fully-cited merge reports a complete chain and injects no warning', async () => {
  const t = await standUp({ allCited: true })
  const traced = await t.h.tool('session_graph_trace').execute({ target: t.key }, t.exec)
  assert.equal(traced.health.ratio, 1, 'every claim cites a real commit: ' + JSON.stringify(traced.health))

  await request(t.h, 'POST', '/sgx/merge/inject', { sessionId: t.B, mergeId: t.merged.merge.id })
  const text = t.h.sectionText('plugin:session-graph')
  assert.doesNotMatch(text, /位置回退/, 'a complete chain must not be flagged as degraded')

  const read = await t.h.tool('session_graph_read').execute({ target: t.key }, t.exec)
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.match(JSON.stringify(read), /A@/, 'the read surface must expose the commit key')
})

test('session_graph_trace explains each proposition and its original location', async () => {
  const t = await standUp({ allCited: true })
  const traced = await t.h.tool('session_graph_trace').execute({ target: t.key }, t.exec)

  assert.equal(traced.ok, true, JSON.stringify(traced))
  assert.equal(traced.kind, 'merge')
  assert.equal(traced.health.total, 3, 'two propositions plus one constraint')
  assert.equal(traced.chains.length, 3, 'both propositions and the constraint are listed')

  const observed = traced.chains.find((c) => c.field === 'propositions' && c.index === 0)
  assert.equal(observed.resolution, 'exact')
  assert.equal(observed.cited, 1)
  assert.equal(observed.chain.commitKey, t.commitKey)
  assert.equal(observed.chain.live, true, 'the cited commit still exists in the DAG')
  assert.equal(observed.chain.locator.userSeq, 11, 'the reader can jump to the original text')
  assert.equal(observed.chain.quote, 'alpha request that is definitely long enough')
  assert.deepEqual(traced.weak, [], 'nothing should be flagged weak')

  // The negativeConstraint is traced exactly like a proposition.
  const constraint = traced.chains.find((c) => c.field === 'negativeConstraints')
  assert.equal(constraint.resolution, 'exact')
  assert.equal(constraint.chain.commitKey, t.commitKey)
})

test('session_graph_trace lists weak chains so they can be re-verified', async () => {
  const t = await standUp({ citation: '【9】' })
  const traced = await t.h.tool('session_graph_trace').execute({ target: t.key }, t.exec)
  assert.equal(traced.ok, true)

  // `allCited` is off, so only the first claim carries a (broken) citation.
  const bad = traced.weak.find((w) => w.claim === 'alpha produced a delta')
  assert.ok(bad, 'the fabricated one must be flagged: ' + JSON.stringify(traced.weak))
  assert.equal(bad.resolution, 'derived')
  assert.equal(bad.cited, 9, 'the impossible citation is reported for diagnosis')
  // A bad citation still yields a real chain: it is paired with the claim at the
  // same position, and `cited: 9` records what it actually claimed.
  const badChain = traced.chains.find((c) => c.claim === 'alpha produced a delta')
  assert.equal(badChain.chain.commitKey, t.commitKey)
  assert.equal(badChain.chain.live, true)

  // The uncited claim sits at position 2 while only ONE commit was supplied, so
  // there is nothing to pair it with. It must come back unresolved with NO
  // chain, rather than borrowing a commit it never rested on.
  const uncited = traced.chains.find((c) => c.claim === 'the delta is reusable')
  assert.equal(uncited.cited, null, 'an uncited claim reports cited: null, not a number')
  assert.equal(uncited.resolution, 'unresolved')
  assert.equal(uncited.chain, null, 'no chain is fabricated when the position exceeds the table')

  // So the three failure modes are all distinguishable: exact, derived+bad
  // citation, and unresolved+no citation.
  assert.equal(traced.health.exact, 0)
  assert.equal(traced.health.derived, 2, JSON.stringify(traced.health))
  assert.equal(traced.health.unresolved, 1)
})

test('session_graph_trace reverses: which conclusions rest on one commit', async () => {
  const t = await standUp({ allCited: true })
  const back = await t.h.tool('session_graph_trace').execute({ target: t.commitKey }, t.exec)

  assert.equal(back.ok, true, JSON.stringify(back))
  assert.equal(back.kind, 'commit')
  assert.equal(back.commit.sessionId, t.A)
  assert.equal(back.commit.turn, 1)
  assert.equal(back.commit.locator.userSeq, 11, 'the commit carries its own original location')
  assert.match(back.commit.userRequest, /alpha request/)

  const claims = back.usedBy.map((u) => u.claim)
  assert.equal(claims.length, 3, 'propositions and constraints both cite it: ' + JSON.stringify(claims))
  assert.ok(claims.includes('alpha produced a delta'), 'propositions: ' + JSON.stringify(claims))
  assert.ok(claims.includes('do not assume beta is empty'), 'negativeConstraints must be searched too: ' + JSON.stringify(claims))
  assert.ok(back.usedBy.every((u) => u.mergeKey.startsWith('mg:')), 'each hit names its merge')
})

test('session_graph_trace distinguishes propositions from constraints by field', async () => {
  const t = await standUp({ allCited: true })
  const traced = await t.h.tool('session_graph_trace').execute({ target: t.key }, t.exec)
  const fields = traced.chains.map((c) => c.field)
  assert.ok(fields.includes('propositions'), 'propositions: ' + fields.join(','))
  assert.ok(fields.includes('negativeConstraints'), 'negativeConstraints: ' + fields.join(','))
  // The index is the position within its own list, so both lists start at 0.
  assert.equal(traced.chains.find((c) => c.field === 'propositions').index, 0)
  assert.equal(traced.chains.find((c) => c.field === 'negativeConstraints').index, 0)
})

test('trace reports not-found rather than inventing an answer', async () => {
  const t = await standUp({ allCited: true })

  assert.deepEqual(await t.h.tool('session_graph_trace').execute({ target: 'mg:nope' }, t.exec), { ok: false, code: 'not-found' })
  assert.deepEqual(await t.h.tool('session_graph_trace').execute({ target: 'Z:9' }, t.exec), { ok: false, code: 'not-found' })
  assert.deepEqual(await t.h.tool('session_graph_trace').execute({ target: '' }, t.exec), { ok: false, code: 'bad-args' })
  assert.deepEqual(await t.h.tool('session_graph_trace').execute({}, t.exec), { ok: false, code: 'bad-args' })
  // A session with no resolved project must not throw.
  const orphan = await t.h.tool('session_graph_trace').execute({ target: t.commitKey }, { agent: { session: { id: 'missing-session' } } })
  assert.equal(orphan.ok, false, JSON.stringify(orphan))
})

test('a merge closed before this enhancement still reads back without lying', async () => {
  const t = await standUp({ allCited: true })

  // Reconstruct a pre-enhancement record by stripping the new fields from the
  // LIVE project, which is what the read surfaces actually consult.
  const p = await t.api.graph.loadProject(t.B)
  const live = (p.projectMerges || []).find((m) => m.id === t.merged.merge.id)
  assert.ok(live, 'the merge must be in the live project')
  for (const list of [live.io.propositions, live.io.negativeConstraints]) {
    for (const item of list) delete item.ground.provenance
  }
  delete live.io.sourceIndex

  const traced = await t.h.tool('session_graph_trace').execute({ target: t.key }, t.exec)
  assert.equal(traced.ok, true, 'legacy records must still be readable')
  assert.equal(traced.health.total, 3, 'the claims are still counted')
  assert.equal(traced.health.unresolved, 3, 'absent chains are unresolved, never assumed exact')
  assert.equal(traced.health.exact, 0)
  assert.equal(traced.health.ratio, 0)
  assert.ok(traced.chains.every((c) => c.chain === null), 'no chain is fabricated for legacy data')
  assert.deepEqual(traced.sourceIndex, [], 'a legacy record has no source index')
  assert.ok(traced.chains.every((c) => c.cited === null), 'and no citation is invented')
  // The legacy text is still carried on the proposition itself, so nothing was
  // destroyed by writing the record through the new code path.
  assert.equal(traced.chains[0].claim, 'alpha produced a delta')
  // `weak` must list them: a legacy entry is by definition not directly
  // locatable, and saying so is the whole point of the surface.
  assert.equal(traced.weak.length, 3, JSON.stringify(traced.weak))
})

test('provenance can be switched off without changing the stored shape', async () => {
  const t = await standUp({ allCited: true, config: { provenance: false } })
  const io = [...t.h.stores.get('merges').values()][0].io
  assert.equal(io.propositions[0].ground.provenance, undefined, 'disabled means no chain is built')
  assert.equal(io.propositions[0].ground.evidence, '【1】', 'the legacy field is still written')

  // Reading back must degrade gracefully rather than throw.
  const traced = await t.h.tool('session_graph_trace').execute({ target: t.key }, t.exec)
  assert.equal(traced.ok, true)
  assert.equal(traced.health.ratio, 0)
  assert.equal(traced.health.unresolved, 3)
})

test('an agent that pre-existed the mount still gets the graph surface', async () => {
  // Regression: the graph plane only listened for `agent/created`, so a plugin
  // installed into a RUNNING host gave no graph tools to the session doing the
  // installing -- while the workflow and subagent planes both back-filled via
  // `ctx.agents.list()`. The three surfaces must agree.
  const h = createHarness('【1】', 'backfill', true)
  const fx = h.fixture
  const B = fx.sessions[2]
  // The agent exists BEFORE apply(): build it, but do not fire agent/created.
  const existing = {
    id: B,
    session: { id: B, header: { cwd: fx.path } },
    options: {},
    ctx: {
      ...h.ctx,
      systemPrompt: { section: (s) => { h.sections.push(s); return () => {} } },
      tools: { register: (t) => { h.tools.push(t); return () => {} } },
    },
  }
  h.ctx.agents.list = () => [existing]

  const { apply } = await import('../lib/index.js')
  apply(h.ctx, {})
  await new Promise((r) => setTimeout(r, 0))

  const names = h.tools.map((t) => t.name)
  for (const name of ['session_graph_view', 'session_graph_read', 'session_graph_trace', 'session_graph_merge']) {
    assert.ok(names.includes(name), name + ' must be registered for a pre-existing agent; got ' + names.join(','))
  }
  assert.ok(h.sections.some((s) => s.name === 'plugin:session-graph'), 'and its prompt section too')
})

test('a workspace registry that throws synchronously still yields the agent surface', async () => {
  // Regression: the workspace lookup used `W.resolveByPath(cwd).catch(...)`. A
  // registry that throws synchronously (or stops returning a promise) makes
  // `.catch` itself the failure, so the whole tool surface is silently lost --
  // no error, just missing tools. Both call sites must await inside try/catch.
  const h = createHarness('【1】', 'syncws', true)
  h.ctx.workspaceRegistry.resolveByPath = () => { throw new Error('registry exploded') }
  const { apply } = await import('../lib/index.js')
  const api = apply(h.ctx, {})
  const fx = h.fixture
  const B = fx.sessions[2]
  await h.createAgent(B)

  // `list()` still resolves the workspace, so the surface must still register.
  for (const name of ['session_graph_view', 'session_graph_read', 'session_graph_trace', 'session_graph_merge']) {
    const names = h.tools.map((t) => t.name)
    assert.ok(names.includes(name), name + ' must register even when resolveByPath throws; got ' + names.join(','))
  }

  // And the fallback path (list() misses, resolveByPath is consulted) must also
  // survive the throw: force the miss with a registry that has no workspaces.
  const h2 = createHarness('【1】', 'syncws2', true)
  h2.ctx.workspaceRegistry = {
    list: () => [],
    resolveByPath: () => { throw new Error('registry exploded') },
  }
  const api2 = apply(h2.ctx, {})
  assert.ok(api2 && api2.graph, 'apply must not throw on a hostile registry')
  const fx2 = h2.fixture
  await h2.createAgent(fx2.sessions[2])
  // loadProject must degrade to "no workspace" rather than rejecting.
  const loaded = await api2.graph.loadProject(fx2.sessions[2])
  assert.equal(loaded.error, undefined, 'the project still loads without a workspace')
})
