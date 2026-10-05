import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachProvenance, buildProvenanceTable, citedIndex, describeProvenance,
  locatorResolvable, parseCommitKey, propositionsFrom, provenanceHealth,
  resolveProvenance,
} from '../lib/provenance-core.js'

const ENTRIES = [
  { key: 'sess-a:1', turn: 1, userSeq: 11, endSeq: 20, time: 100, userTime: 99, userText: '第一条请求' },
  { key: 'sess-a:2', turn: 2, userSeq: 25, endSeq: 40, time: 200, userTime: 199, userText: '第二条请求' },
  { key: 'sess-b:1', turn: 1, userSeq: 5, endSeq: 9, time: 300, userTime: 298, userText: '别处的一条' },
]

test('commit keys split on the last colon so opaque session ids survive', () => {
  assert.deepEqual(parseCommitKey('sess-a:3'), { sessionId: 'sess-a', turn: 3 })
  // a session id containing colons must not be truncated at the first one
  assert.deepEqual(parseCommitKey('a:b:c:7'), { sessionId: 'a:b:c', turn: 7 })
  assert.deepEqual(parseCommitKey('nocolon'), { sessionId: 'nocolon', turn: null })
  assert.deepEqual(parseCommitKey(''), { sessionId: '', turn: null })
})

test('a synthetic merge or revert node claims no session', () => {
  // `mg:`/`rev:` nodes are DAG nodes, not commits in a session log. Reporting
  // `sessionId: 'mg'` would be a followable lie, so they report null.
  assert.deepEqual(parseCommitKey('mg:abc123'), { sessionId: null, turn: null })
  assert.deepEqual(parseCommitKey('rev:abc123'), { sessionId: null, turn: null })
  // A real session id that merely starts with those letters is untouched.
  assert.deepEqual(parseCommitKey('mgmt:4'), { sessionId: 'mgmt', turn: 4 })
  assert.deepEqual(parseCommitKey('review:2'), { sessionId: 'review', turn: 2 })
  // A node with no locatable turn still reports a null session rather than
  // inventing one from the prefix.
  assert.deepEqual(parseCommitKey('mg:mg:nested'), { sessionId: 'mg:mg', turn: null })
})

test('citation parsing accepts the bracketed marker and rejects stray digits', () => {
  assert.equal(citedIndex('【2】'), 2)
  assert.equal(citedIndex('见【12】所述'), 12)
  assert.equal(citedIndex('【 4 】'), 4)
  assert.equal(citedIndex('3'), 3)
  // a digit inside a larger token is not a citation
  assert.equal(citedIndex('v2'), null)
  assert.equal(citedIndex('sess-a:1'), null)
  assert.equal(citedIndex(''), null)
  assert.equal(citedIndex('无引用'), null)
  // index 0 is not a valid 1-based citation
  assert.equal(citedIndex('【0】'), null)
})

test('the provenance table indexes entries 1-based and carries the event range', () => {
  const table = buildProvenanceTable(ENTRIES)
  assert.equal(table.size, 3)
  const second = table.get(2)
  assert.equal(second.commitKey, 'sess-a:2')
  assert.equal(second.sessionId, 'sess-a')
  assert.equal(second.turn, 2)
  assert.equal(second.userSeq, 25)
  assert.equal(second.endSeq, 40)
})

test('entries without a usable key are skipped rather than indexed', () => {
  const table = buildProvenanceTable([{ key: 'sess-a:1' }, null, { key: '' }, {}, { key: 'sess-a:2' }])
  // only the two keyed entries survive; their indices are their input positions
  assert.equal(table.size, 2)
  assert.equal(table.get(1).commitKey, 'sess-a:1')
  assert.equal(table.get(5).commitKey, 'sess-a:2')
})

test('an in-range citation resolves exactly to the cited commit', () => {
  const table = buildProvenanceTable(ENTRIES)
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '【2】' } }, table, 0)
  assert.equal(chain.resolution, 'exact')
  assert.equal(chain.cited, 2)
  assert.equal(chain.commitKey, 'sess-a:2')
  assert.deepEqual(chain.locator, { userSeq: 25, endSeq: 40 })
})

test('an out-of-range citation degrades visibly instead of silently', () => {
  const table = buildProvenanceTable(ENTRIES)
  // cites 【9】, which does not exist; proposition sits at position 1 (index 2)
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '【9】' } }, table, 1)
  assert.equal(chain.resolution, 'derived')
  assert.equal(chain.cited, 9, 'the unusable citation is preserved for diagnosis')
  assert.equal(chain.commitKey, 'sess-a:2', 'falls back to the positional entry')
})

test('a missing citation degrades to the positional entry', () => {
  const table = buildProvenanceTable(ENTRIES)
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'inferred', evidence: '' } }, table, 0)
  assert.equal(chain.resolution, 'derived')
  assert.equal(chain.cited, null, 'no citation is distinguishable from a bad one')
  assert.equal(chain.commitKey, 'sess-a:1')
})

test('a provenance chain is never fabricated when there is no entry to cite', () => {
  const empty = buildProvenanceTable([])
  assert.equal(resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '【1】' } }, empty, 0), null)
  // position beyond the table with no citation to fall back on
  const table = buildProvenanceTable(ENTRIES)
  assert.equal(resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '【9】' } }, table, 99), null)
})

test('evidence naming a commit key outright resolves exactly, not positionally', () => {
  const table = buildProvenanceTable(ENTRIES)
  // The deterministic fallback extraction cites `c.key` verbatim. That is an
  // identification, not a guess, so it must not be reported as 'derived'.
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'inferred', evidence: 'sess-b:1' } }, table, 0)
  assert.equal(chain.resolution, 'exact')
  assert.equal(chain.commitKey, 'sess-b:1', 'the named key wins over the positional entry')
  assert.equal(chain.cited, 3, 'the matched index is recorded like any other citation')
  assert.equal(chain.locator.userSeq, 5, 'the real locator comes from the named entry')
})

test('a key citation inside a longer sentence still resolves', () => {
  const table = buildProvenanceTable(ENTRIES)
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '依据 sess-a:2 的原文' } }, table, 0)
  assert.equal(chain.resolution, 'exact')
  assert.equal(chain.commitKey, 'sess-a:2')
})

test('a shorter key is not satisfied by a longer key that starts with it', () => {
  // `s:1` must not match inside `s:12`; the digit boundary disambiguates.
  const table = buildProvenanceTable([
    { key: 's:1', turn: 1, userSeq: 1, endSeq: 2, time: 1 },
    { key: 's:12', turn: 12, userSeq: 3, endSeq: 4, time: 2 },
  ])
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: 'see s:12' } }, table, 0)
  assert.equal(chain.commitKey, 's:12', 'the longer, more specific key wins')
  assert.equal(chain.resolution, 'exact')
})

test('an unknown key in evidence does not fabricate a match', () => {
  const table = buildProvenanceTable(ENTRIES)
  // `sess-z:7` is not in the table: fall back positionally and stay labelled
  // as a degradation rather than inventing a chain.
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: 'sess-z:7' } }, table, 0)
  assert.equal(chain.resolution, 'derived')
  assert.equal(chain.commitKey, 'sess-a:1')
  assert.equal(chain.cited, null, 'no usable citation is found')
})

test('an explicit 【n】 marker is preferred over a key that also appears', () => {
  const table = buildProvenanceTable(ENTRIES)
  const chain = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '【2】 (sess-b:1)' } }, table, 0)
  assert.equal(chain.commitKey, 'sess-a:2', 'the model-authored marker is authoritative')
  assert.equal(chain.cited, 2)
})

test('attachProvenance preserves the legacy evidence field and adds sourceIndex', () => {
  const table = buildProvenanceTable(ENTRIES)
  const io = attachProvenance({
    propositions: [{ claim: 'A', ground: { kind: 'observed', evidence: '【2】' } }],
    negativeConstraints: [{ claim: 'B', ground: { kind: 'assumed', evidence: '【1】' } }],
    openQuestions: ['q'], deliberateExclusions: ['d'],
  }, table)
  // the free-text citation survives, so older readers keep working
  assert.equal(io.propositions[0].ground.evidence, '【2】')
  assert.equal(io.propositions[0].ground.kind, 'observed')
  assert.equal(io.propositions[0].ground.provenance.commitKey, 'sess-a:2')
  assert.equal(io.negativeConstraints[0].ground.provenance.commitKey, 'sess-a:1')
  // sourceIndex lets a reader jump from any claim to the full input list
  assert.equal(io.sourceIndex.length, 3)
  assert.equal(io.sourceIndex[0].index, 1)
  assert.equal(io.openQuestions[0], 'q')
  assert.equal(io.deliberateExclusions[0], 'd')
})

test('attachProvenance does not mutate its input', () => {
  const table = buildProvenanceTable(ENTRIES)
  const original = { propositions: [{ claim: 'A', ground: { kind: 'observed', evidence: '【1】' } }] }
  const frozen = JSON.stringify(original)
  const out = attachProvenance(original, table)
  assert.equal(JSON.stringify(original), frozen, 'input must be untouched')
  assert.notEqual(out.propositions[0], original.propositions[0])
  assert.equal(original.propositions[0].ground.provenance, undefined)
})

test('ground kinds and evidence survive a round trip through JSON', () => {
  const table = buildProvenanceTable(ENTRIES)
  const io = attachProvenance({ propositions: [{ claim: 'A', ground: { kind: 'produced', evidence: '【3】' } }] }, table)
  const revived = JSON.parse(JSON.stringify(io))
  assert.equal(revived.propositions[0].ground.provenance.commitKey, 'sess-b:1')
  assert.equal(revived.propositions[0].ground.provenance.locator.userSeq, 5)
  assert.equal(revived.propositions[0].ground.kind, 'produced')
})

test('provenanceHealth counts each resolution class', () => {
  const table = buildProvenanceTable(ENTRIES)
  const io = attachProvenance({
    propositions: [
      { claim: 'exact', ground: { kind: 'observed', evidence: '【1】' } },
      { claim: 'derived', ground: { kind: 'inferred', evidence: '【9】' } },
    ],
    negativeConstraints: [],
  }, table)
  const health = provenanceHealth(io)
  assert.equal(health.total, 2)
  assert.equal(health.exact, 1)
  assert.equal(health.derived, 1)
  assert.equal(health.unresolved, 0)
  assert.equal(health.ratio, 0.5)
})

test('provenanceHealth reports an empty object as healthy, not unhealthy', () => {
  const health = provenanceHealth({ propositions: [] })
  assert.equal(health.total, 0)
  assert.equal(health.ratio, 1)
})

test('provenanceHealth counts claims with no chain as unresolved', () => {
  const health = provenanceHealth({ propositions: [{ claim: 'bare' }] })
  assert.equal(health.total, 1)
  assert.equal(health.unresolved, 1)
  assert.equal(health.ratio, 0)
})

test('reverse lookup returns every claim resting on one commit', () => {
  const table = buildProvenanceTable(ENTRIES)
  const io = attachProvenance({
    propositions: [
      { claim: 'A', ground: { kind: 'observed', evidence: '【2】' } },
      { claim: 'B', ground: { kind: 'observed', evidence: '【2】' } },
      { claim: 'C', ground: { kind: 'observed', evidence: '【1】' } },
    ],
    negativeConstraints: [{ claim: 'D', ground: { kind: 'assumed', evidence: '【2】' } }],
  }, table)
  const hits = propositionsFrom(io, 'sess-a:2')
  assert.equal(hits.length, 3)
  assert.deepEqual(hits.map((h) => h.claim), ['A', 'B', 'D'])
  assert.equal(hits[2].field, 'negativeConstraints')
  assert.equal(propositionsFrom(io, 'sess-b:1').length, 0)
})

test('reverse lookup tolerates a legacy information object with no chains', () => {
  assert.deepEqual(propositionsFrom({ propositions: [{ claim: 'old', ground: { kind: 'observed', evidence: '【1】' } }] }, 'sess-a:1'), [])
  assert.deepEqual(propositionsFrom(null, 'x'), [])
})

test('locatorResolvable requires a real, ordered event range', () => {
  assert.equal(locatorResolvable({ userSeq: 1, endSeq: 2 }), true)
  assert.equal(locatorResolvable({ userSeq: 2, endSeq: 2 }), true)
  assert.equal(locatorResolvable({ userSeq: 3, endSeq: 2 }), false, 'endSeq before userSeq')
  assert.equal(locatorResolvable({ userSeq: null, endSeq: 2 }), false)
  assert.equal(locatorResolvable({}), false)
  assert.equal(locatorResolvable(null), false)
})

test('describeProvenance renders a one-line chain and flags degradation', () => {
  const table = buildProvenanceTable(ENTRIES)
  const exact = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '【2】' } }, table, 0)
  const text = describeProvenance(exact)
  assert.match(text, /sess-a:2/)
  assert.match(text, /turn 2/)
  assert.match(text, /seq 25–40/)
  assert.doesNotMatch(text, /derived/, 'an exact chain is not flagged')
  const derived = resolveProvenance({ claim: 'x', ground: { kind: 'observed', evidence: '【9】' } }, table, 1)
  assert.match(describeProvenance(derived), /\[derived\]/)
  assert.match(describeProvenance(null), /无溯源链/)
})

test('the deterministic fallback pairs every claim with its own commit', () => {
  // The no-LLM path emits one proposition per commit with the commit key as its
  // evidence. Because the key names the entry outright, each chain resolves
  // EXACTLY to that commit rather than degrading to a positional guess -- the
  // pairing is not merely self-consistent, it is identified.
  const entries = [
    { key: 's:1', turn: 1, userSeq: 1, endSeq: 2, time: 1, userText: 'one' },
    { key: 's:2', turn: 2, userSeq: 3, endSeq: 4, time: 2, userText: 'two' },
    { key: 's:3', turn: 3, userSeq: 5, endSeq: 6, time: 3, userText: 'three' },
  ]
  const table = buildProvenanceTable(entries)
  const propositions = entries.map((entry) => ({ claim: entry.userText, ground: { kind: 'inferred', evidence: entry.key } }))
  const io = attachProvenance({ propositions, negativeConstraints: [] }, table)
  for (let i = 0; i < entries.length; i++) {
    const chain = io.propositions[i].ground.provenance
    assert.equal(chain.commitKey, entries[i].key)
    assert.equal(chain.resolution, 'exact', 'a named key is an identification, not a guess')
    assert.equal(chain.cited, i + 1, 'the matched 1-based index is recorded')
    assert.equal(chain.locator.userSeq, entries[i].userSeq, 'the real locator is carried through')
  }
  assert.equal(provenanceHealth(io).ratio, 1, 'a fully identified extraction is fully healthy')
})

test('every claim gets a chain when the table covers the input', () => {
  const table = buildProvenanceTable(ENTRIES)
  const io = attachProvenance({
    propositions: Array.from({ length: 3 }, (_, i) => ({ claim: 'c' + i, ground: { kind: 'inferred', evidence: '【' + (i + 1) + '】' } })),
  }, table)
  assert.equal(provenanceHealth(io).exact, 3)
  assert.equal(provenanceHealth(io).ratio, 1)
})
