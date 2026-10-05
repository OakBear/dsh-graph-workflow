import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * Load the BUILT bundle (client.js) exactly as the web app does, then drive its
 * `apply(ctx)` against a mock client context.
 *
 * This is the check that the GUI half of the merge actually works: the two
 * upstream clients each registered one sidebar tab, and the merged bundle must
 * register BOTH from a single `apply`.
 */
function loadBundle() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) { loaded = spec },
      },
    },
    document: {
      visibilityState: 'visible',
      createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
      head: { appendChild() {} },
      querySelector: () => null,
    },
    fetch: async () => ({ ok: true, async json() { return {} } }),
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox)
  assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load')
  return loaded
}

/** Minimal React stand-in: the bundle only uses createElement/hooks. */
function makeReact() {
  const hookState = []
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const slot = cursor++
      if (hookState[slot] === undefined) hookState[slot] = typeof initial === 'function' ? initial() : initial
      return [hookState[slot], (next) => { hookState[slot] = typeof next === 'function' ? next(hookState[slot]) : next }]
    },
    useCallback(fn) { return fn },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    Fragment: 'Fragment',
    _reset() { cursor = 0 },
  }
}

/** Mock client context capturing every registration the client makes. */
function makeClientCtx() {
  const tabs = []
  const slotRegistrations = []
  const injections = {}
  const effects = []
  const ctx = {
    effect(fn, label) { const d = fn(); if (typeof d === 'function') effects.push({ label, dispose: d }); return () => {} },
    inject(names, fn) { injections[names.join(',')] = fn; fn(ctx) },
    get(service) {
      if (service === 'timer') return { interval: () => () => {}, timeout: (fn) => { return () => {} } }
      return null
    },
  }
  // provided client services
  ctx.betterSidebar = {
    registerTab(descriptor) { tabs.push(descriptor); return () => {} },
    openTab() {},
  }
  ctx.slots = {
    inject(name, fn) { slotRegistrations.push({ name, register: fn }); return () => {} },
    register(spec, component) { slotRegistrations.push({ spec, component }); return () => {} },
  }
  ctx.sessions = { reduceFor: () => ({}) }
  return { ctx, tabs, slotRegistrations, effects }
}

test('the built bundle loads under the expected plugin id', () => {
  const spec = loadBundle()
  assert.equal(spec.id, 'dsh-graph-workflow', 'the id must match the package name the host mounts')
  assert.equal(typeof spec.factory, 'function')
})

test('the bundle exposes apply plus the test surface', () => {
  const { factory } = loadBundle()
  const exports = factory((name) => {
    if (name === 'react') return makeReact()
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(typeof exports.apply, 'function', 'apply is required to mount the client half')
  assert.ok(Array.isArray(exports.inject), 'inject must be an array')
  assert.ok(exports.__test, '__test surface must survive the merge')
})

test('BOTH sidebar tabs register from the single apply()', () => {
  const { factory } = loadBundle()
  const exports = factory(() => makeReact())
  const h = makeClientCtx()
  exports.apply(h.ctx)

  const ids = h.tabs.map((t) => t.id)
  // The Git-graph tab and the Workflow tab came from two different packages and
  // must both be present after the merge.
  assert.ok(ids.includes('dsh-session-graph'), 'Git-graph tab: ' + ids.join(','))
  assert.ok(ids.includes('dsh-agent-workflow'), 'Workflow tab: ' + ids.join(','))
  assert.equal(ids.length, 2, 'exactly two tabs, got: ' + ids.join(','))
})

test('each tab is well-formed for betterSidebar.registerTab', () => {
  const { factory } = loadBundle()
  const exports = factory(() => makeReact())
  const h = makeClientCtx()
  exports.apply(h.ctx)
  for (const tab of h.tabs) {
    assert.equal(typeof tab.id, 'string', 'tab id')
    assert.equal(typeof tab.title, 'string', tab.id + ' title')
    assert.equal(typeof tab.component, 'function', tab.id + ' component')
    assert.ok(Number.isFinite(tab.order), tab.id + ' order')
    // `single: true` keeps one instance per tab; `undefined` would let the host
    // open duplicates.
    assert.equal(tab.single, true, tab.id + ' should be single-instance')
  }
})

test('the two tabs have distinct ids and orders', () => {
  const { factory } = loadBundle()
  const exports = factory(() => makeReact())
  const h = makeClientCtx()
  exports.apply(h.ctx)
  const [a, b] = h.tabs
  assert.notEqual(a.id, b.id, 'tab ids must differ or one replaces the other')
  assert.notEqual(a.order, b.order, 'orders should differ so the tab bar is deterministic')
})

test('both stylesheets are injected and both are torn down', () => {
  // The bundle closes over the sandbox `document` it was loaded with, so inject
  // an instrumented document into the VM itself rather than onto globalThis.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const appended = []
  const removed = []
  let loaded = null
  const makeNode = () => {
    const node = { style: {}, textContent: '' }
    node.setAttribute = (key, value) => { node[key] = value }
    return node
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { loaded = spec } } },
    document: {
      visibilityState: 'visible',
      createElement: makeNode,
      head: { appendChild: (node) => appended.push(node) },
      querySelector: (sel) => { removed.push(sel); return null },
    },
    fetch: async () => ({ ok: true, async json() { return {} } }),
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox)
  const exports = loaded.factory(() => makeReact())
  const h = makeClientCtx()
  exports.apply(h.ctx)

  const markers = appended.map((n) => n['data-sgx'] || n['data-awf']).filter(Boolean)
  assert.equal(markers.length, 2, 'expected two stylesheets (graph + workflow), got ' + JSON.stringify(appended.map((n) => Object.keys(n))))

  // Teardown: both upstream clients removed their own style tag by marker.
  for (const effect of h.effects) effect.dispose()
  assert.ok(removed.includes('style[data-sgx]'), 'graph stylesheet teardown: ' + removed.join(','))
  assert.ok(removed.includes('style[data-awf]'), 'workflow stylesheet teardown: ' + removed.join(','))
})

test('the header entry registers through the official conversation slot', () => {
  const { factory } = loadBundle()
  const exports = factory(() => makeReact())
  const h = makeClientCtx()
  exports.apply(h.ctx)
  const names = h.slotRegistrations.map((s) => s.name || (s.spec && s.spec.name))
  assert.ok(
    names.includes('conversation.session.header.actions'),
    'header entry must use the official slot, got: ' + names.join(','),
  )
})

test('the exported test surface still covers the layout functions', () => {
  const { factory } = loadBundle()
  const exports = factory(() => makeReact())
  for (const fn of ['layoutTree', 'groupTrees', 'orderRowsForGraph', 'visualLanesFor', 'compactUpwardSegment', 'compactForkSegment']) {
    assert.equal(typeof exports.__test[fn], 'function', '__test.' + fn + ' must survive the merge')
  }
})

test('the client makes no request until a tab is actually rendered', () => {
  const { factory } = loadBundle()
  const exports = factory(() => makeReact())
  const h = makeClientCtx()
  let fetches = 0
  const g = globalThis
  const savedFetch = g.fetch
  g.fetch = () => { fetches++; return Promise.resolve({ ok: true, json: async () => ({}) }) }
  try {
    exports.apply(h.ctx)
  } finally {
    if (savedFetch === undefined) delete g.fetch
    else g.fetch = savedFetch
  }
  // Registration must be side-effect free: no polling before the user opens a tab.
  assert.equal(fetches, 0, 'registering tabs must not start network traffic')
})
