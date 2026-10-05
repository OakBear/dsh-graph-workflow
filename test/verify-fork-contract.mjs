// One-off verification against the REAL @deepseek-ai/dsh-session implementation.
//
// The unit suites use mocks, and a mock can always be made to agree with the
// code under test. This script instead drives the host's own SessionStore with
// the exact option shape `lib/workflow.js` passes to `ctx.agents.create`, and
// asserts the resulting session header / inherited-prefix state.
//
// It also demonstrates that the OLD shape is silently degraded -- not rejected
// loudly -- which is why the defect survived.
//
// Run: node test/verify-fork-contract.mjs
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let SessionStore
try {
  ({ default: SessionStore } = require('@deepseek-ai/dsh-session'))
} catch (e) {
  console.log('SKIP: @deepseek-ai/dsh-session not resolvable from here (' + e.code + ')')
  console.log('      Run this from the dsh install tree, or link the package.')
  process.exit(0)
}

const { SessionLogOffset, SessionSeq } = require('@deepseek-ai/dsh-session/types')
const { buildForkSeed } = require('@deepseek-ai/dsh-session')

// --- build a parent log exactly the way the plugin does -------------------
// workflow.js: boundary = lastCompletedBoundary(events); seed = events.slice(0, boundary + 1)
//
// Surface-eligible events (user/message, assistant/message) require a
// `surfaceOp` marker that the store stamps during `append`. Hand-written event
// literals are therefore rejected as a seed, so the parent log is produced
// through the real Session.append() API and then sliced -- exactly what the
// plugin receives from `sessionQuery.readSession()`.
function turn(turnId, seq, time) {
  return [
    { type: 'turn/start', seq, time, data: { turn: turnId } },
    {
      type: 'user/message', seq: seq + 1, time: time + 1,
      data: { id: 'm-user-' + turnId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' + turnId }] },
    },
    {
      type: 'assistant/message', seq: seq + 2, time: time + 2,
      // `turn`, `step` and `stream` are the settlement fields the store
      // validates when replaying a seed; an assistant message carries an
      // (opaque) stream array rather than cited source seqs.
      data: { turn: turnId, step: 0, stream: [], message: { id: 'm-asst-' + turnId, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock-1' }, content: [{ type: 'text', text: 'a' + turnId }] } },
    },
    { type: 'turn/end', seq: seq + 3, time: time + 3, data: { turn: turnId, reason: 'completed' } },
  ]
}

// SessionStore extends the cordis Service base, so it needs a real fiber to
// publish itself into. Boot a minimal Context rather than hand-rolling one --
// this keeps the whole exercise on host code paths.
let Context
try {
  ({ Context } = require('@deepseek-ai/cordis'))
} catch (e) {
  console.log('SKIP: @deepseek-ai/cordis not resolvable (' + e.code + ')')
  process.exit(0)
}
const root = new Context()
const store = new SessionStore(root)
const parentId = 'session-parent-0001'

// Build the parent through the real API so every event carries the surface
// metadata the store stamps on append.
const parent = store.prepare(parentId, { meta: { cwd: 'C:/repo' } })
for (const ev of [...turn(0, 0, 100), ...turn(1, 4, 200)]) {
  // Surface-eligible message events take a SurfaceIntent; `SurfaceOp` is the
  // bare string 'append' (only replacement carries an object). Every other
  // event must NOT carry one.
  if (ev.type === 'user/message' || ev.type === 'assistant/message') {
    // `sourceEventSeqs` is optional: when present it must be a NON-EMPTY set of
    // earlier seqs. A user message cites nothing, so the key is omitted.
    parent.append(ev.type, ev.data, { surfaceOp: 'append' })
  } else {
    parent.append(ev.type, ev.data)
  }
}
const parentEvents = parent.snapshotEvents()
const boundary = parentEvents.length - 1
// The plugin slices the prefix directly. `buildForkSeed` is the host's own
// helper: it appends the `session/end-seed {inherited:true}` marker and closes
// any open tail. Both shapes are exercised so the contract holds either way.
const plainSlice = parentEvents.slice(0, boundary + 1)
const seed = buildForkSeed(parentEvents, boundary)

function attempt(label, options) {
  const id = 'session-child-' + Math.random().toString(16).slice(2, 8)
  try {
    // `prepare` builds the session but does NOT enter it into the store; keep
    // the returned instance directly so the header stays inspectable.
    const session = store.prepare(id, options)
    return { id, ok: true, session }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

const results = []

// --- 1. NEW shape: isSeeded + top-level inheritedEventCount ---------------
const fixed = attempt('fixed', {
  meta: { cwd: 'C:/repo', parentSession: parentId, isSeeded: true },
  seed,
  inheritedEventCount: SessionLogOffset(seed.length),
})
results.push(['new shape (isSeeded + inheritedEventCount)', fixed])

// --- 1b. NEW shape over a raw prefix slice (no end-seed marker) -----------
// This is what lib/workflow.js actually passes: `events.slice(0, boundary+1)`.
const rawSlice = attempt('rawslice', {
  meta: { cwd: 'C:/repo', parentSession: parentId, isSeeded: true },
  seed: plainSlice,
  inheritedEventCount: SessionLogOffset(plainSlice.length),
})
results.push(['new shape over a raw prefix slice', rawSlice])

// --- 2. OLD shape: seedLength inside meta ---------------------------------
const legacy = attempt('legacy', {
  meta: { cwd: 'C:/repo', parentSession: parentId, seedLength: seed.length },
  seed,
})
results.push(['old shape (meta.seedLength)', legacy])

// --- 3. old field name at the TOP level (would be rejected) ---------------
const topLevel = attempt('toplevel', {
  meta: { cwd: 'C:/repo', parentSession: parentId },
  seed,
  seedLength: seed.length,
})
results.push(['top-level seedLength (not a real option)', topLevel])

let failed = 0
console.log('')
console.log('=== driving the REAL @deepseek-ai/dsh-session SessionStore ===')
console.log('')
for (const [label, r] of results) {
  if (!r.ok) {
    console.log('  ' + label + ' -> REJECTED: ' + r.error)
    continue
  }
  const s = r.session
  const h = s.header
  const marker = s.eventsSnapshot?.[s.inheritedEventCount]
  console.log('  ' + label)
  console.log('      accepted           : yes')
  console.log('      header.isSeeded    : ' + h.isSeeded)
  console.log('      header.seedLength  : ' + String(h.seedLength))
  console.log('      inheritedEventCount: ' + s.inheritedEventCount)
  console.log('      isOwnSeq(0)        : ' + s.isOwnSeq(0) + '   (false => inherited)')
  console.log('      event at cut       : ' + (marker ? marker.type + ' ' + JSON.stringify(marker.data) : '(none)'))
}

console.log('')

// The new shape must produce a genuinely seeded session whose inherited
// prefix covers the whole seed.
const fixedSession = fixed.ok ? fixed.session : null
const checks = [
  ['new shape accepted by the real store', fixed.ok],
  ['new shape marks the header seeded', fixedSession?.header?.isSeeded === true],
  ['new shape records the inherited prefix length', fixedSession?.inheritedEventCount === seed.length],
  ['inherited prefix is NOT own work', fixedSession ? fixedSession.isOwnSeq(0) === false : false],
  ['no seedLength leaks onto the header', fixedSession ? fixedSession.header.seedLength === undefined : false],
]
// The plugin passes a raw prefix slice (no synthetic end-seed marker), so that
// exact shape must be accepted too.
const rawSession = rawSlice.ok ? rawSlice.session : null
checks.push(
  ['raw prefix slice accepted', rawSlice.ok],
  ['raw slice marks the header seeded', rawSession?.header?.isSeeded === true],
  ['raw slice records the inherited prefix length', rawSession?.inheritedEventCount === plainSlice.length],
  ['raw slice prefix is NOT own work', rawSession ? rawSession.isOwnSeq(0) === false : false],
)
// The legacy shape must be silently degraded (accepted, but NOT seeded) -- the
// exact failure mode that made this defect invisible.
const legacySession = legacy.ok ? legacy.session : null
checks.push(
  ['legacy shape is silently accepted (proving the defect is quiet)', legacy.ok === true],
  ['legacy shape leaves the header UNSEEDED', legacySession?.header?.isSeeded === false],
  ['legacy shape records NO inherited prefix', legacySession?.inheritedEventCount === 0],
  [
    'legacy shape misattributes inherited events to the child',
    legacySession ? legacySession.isOwnSeq(0) === true : false,
  ],
  // Neither position for the removed key fails loudly. `validateSessionHeader`
  // does throw on a persisted `seedLength`, but creation rebuilds the header
  // from a fixed field list, so that guard is unreachable from this path -- the
  // defect can only ever be silent.
  ['top-level seedLength is ignored, not rejected', topLevel.ok === true],
  ['top-level seedLength does not mark the session seeded', topLevel.ok ? topLevel.session.header.isSeeded === false : false],
)

for (const [label, pass] of checks) {
  console.log((pass ? '  ok   ' : '  FAIL ') + label)
  if (!pass) failed++
}
console.log('')
if (failed > 0) {
  console.error(failed + ' check(s) failed')
  process.exit(1)
}
console.log('all real-host contract checks passed')
