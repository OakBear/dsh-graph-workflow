/**
 * Structured provenance chain (pure).
 *
 * ── The problem this solves ──────────────────────────────────────────────
 * Upstream, an extracted proposition carried its justification as free text:
 *
 *     ground: { kind: 'observed', evidence: '【2】' }
 *
 * `【2】` means "the 2nd commit in this particular extraction's input list".
 * That reference is fragile in three independent ways:
 *   1. It is positional, so it only means anything next to the exact input
 *      array the LLM saw. Re-extract with a different delta and `【2】` silently
 *      points at a different commit.
 *   2. It is re-parsed by regex at render time (`/(\d+)/`), so any unrelated
 *      number in the text (`【1】`, "2 个提交", "v2") is a candidate match.
 *   3. The LLM can emit an out-of-range or invented index, and nothing detects
 *      it — the chain from claim to evidence is unverifiable exactly when it
 *      matters most.
 *
 * ── What this module does ────────────────────────────────────────────────
 * It compiles the positional reference into a STRUCTURED, self-describing
 * chain that survives storage and re-serialisation:
 *
 *     proposition.claim
 *       └─ ground.provenance
 *            ├─ commitKey  'session-abc:3'      ← stable identity in the DAG
 *            ├─ sessionId  'session-abc'
 *            ├─ turn       3
 *            ├─ locator    { userSeq, endSeq }  ← exact event range in the log
 *            ├─ time, userTime
 *            ├─ quote                            ← the text the claim rests on
 *            └─ resolution 'exact' | 'derived' | 'unresolved'
 *
 * `locator` is the "original text location": `userSeq` is the seq of the user
 * message event and `endSeq` the seq of the closing `turn/end`, so the exact
 * source spans are addressable in the session log without re-reading the whole
 * history. Resolution is therefore reversible: claim → commit → source events.
 *
 * Resolution is deterministic and total:
 *   - a valid index resolves to that entry ('exact');
 *   - an out-of-range/invented index falls back to the proposition's own
 *     position in the list when that position exists ('derived'), so a chain is
 *     still produced and the downgrade is visible rather than hidden;
 *   - with no usable entry at all the chain is emitted with `resolution:
 *     'unresolved'` and no locator — never fabricated.
 */

/** Ground kinds, in the vocabulary the extractor prompt uses. */
export const GROUND_KINDS = Object.freeze(['observed', 'inferred', 'assumed', 'produced'])

/** Marker the extractor prompt asks the model to cite, e.g. `【2】` → 2. */
const CITE_RE = /【\s*(\d+)\s*】/

/**
 * Split a commit key into its owner and turn.
 *
 * Keys are built as `owner + ':' + turn`. The owner is recovered with
 * `lastIndexOf` because a session id is opaque and we must not assume it is
 * colon-free.
 *
 * @param {string} key
 * @returns {{sessionId: string|null, turn: number|null}}
 */
export function parseCommitKey(key) {
  const text = String(key || '')
  // A DAG node key is either `<sessionId>:<turn>` (a commit) or a prefixed
  // synthetic node: `mg:<mergeId>` / `rev:<mergeId>`. A merge or revert node
  // belongs to NO session, so reporting `sessionId: 'mg'` would be a lie that a
  // reader could follow. It is reported as null instead, which is also what
  // `locatorResolvable` requires: such a node has no source text to locate.
  const cut = text.lastIndexOf(':')
  if (cut <= 0) return { sessionId: text, turn: null }
  const sessionId = text.slice(0, cut)
  if (sessionId === 'mg' || sessionId === 'rev') return { sessionId: null, turn: null }
  const turn = Number(text.slice(cut + 1))
  return { sessionId, turn: Number.isFinite(turn) ? turn : null }
}

/**
 * Pull the first cited index out of a free-text evidence field.
 * @param {string} evidence
 * @returns {number|null} 1-based index, or null when nothing is cited.
 */
export function citedIndex(evidence) {
  const match = CITE_RE.exec(String(evidence || ''))
  if (match) {
    const n = Number(match[1])
    return Number.isFinite(n) && n >= 1 ? n : null
  }
  // Tolerate a bare leading integer, but only when it is not part of a larger
  // token such as a version string or a commit key.
  const bare = /^\s*(\d+)\s*$/.exec(String(evidence || ''))
  if (bare) {
    const n = Number(bare[1])
    return Number.isFinite(n) && n >= 1 ? n : null
  }
  return null
}

function firstLine(value, cap) {
  const line = String(value || '').trim().split(/\r?\n/)[0] || ''
  return line.length > cap ? line.slice(0, cap) + '…' : line
}

/**
 * Build the resolution table for one extraction: 1-based input index → the
 * location of the commit the model was shown at that index.
 *
 * Entries must carry at least `key`; `turn`, `userSeq`, `endSeq`, `time`,
 * `userTime` and `userText` are carried through when present.
 *
 * @param {Array<object>} entries
 * @returns {Map<number, object>}
 */
export function buildProvenanceTable(entries) {
  const table = new Map()
  const list = Array.isArray(entries) ? entries : []
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (!entry || typeof entry.key !== 'string' || !entry.key) continue
    const parsed = parseCommitKey(entry.key)
    table.set(i + 1, {
      index: i + 1,
      commitKey: entry.key,
      sessionId: parsed.sessionId,
      turn: entry.turn === undefined || entry.turn === null ? parsed.turn : entry.turn,
      userSeq: entry.userSeq === undefined || entry.userSeq === null ? null : entry.userSeq,
      endSeq: entry.endSeq === undefined || entry.endSeq === null ? null : entry.endSeq,
      time: entry.time === undefined || entry.time === null ? null : entry.time,
      userTime: entry.userTime === undefined || entry.userTime === null ? null : entry.userTime,
      quote: firstLine(entry.userText, 160),
      summary: firstLine(entry.summary, 200),
      kind: entry.kind || 'commit',
    })
  }
  return table
}

/**
 * Find the table entry named DIRECTLY by a commit key inside the evidence text.
 *
 * `citedIndex` only understands the `【n】` marker the extractor prompt asks for,
 * but the deterministic fallback extraction cites the commit key itself
 * (`evidence: c.key`) -- an identification that is exact by construction. Treat
 * that as a first-class citation instead of degrading it to a positional guess,
 * which would understate a chain that is genuinely known.
 *
 * Matching is deliberately conservative:
 *   - only keys already present in the table can match (never invent one);
 *   - a longer key that merely starts with a shorter one (`s:1` inside `s:12`)
 *     must not satisfy the shorter entry, so a digit following the match
 *     disqualifies it;
 *   - the longest match wins, so an ambiguous overlap resolves to the most
 *     specific key.
 *
 * @param {string} evidence
 * @param {Map<number, object>} table from {@link buildProvenanceTable}
 * @returns {number|null} the matching 1-based index, or null
 */
export function keyIndexIn(evidence, table) {
  const text = String(evidence || '')
  if (!text || !table || table.size === 0) return null
  let best = null
  let bestLength = -1
  for (const [index, entry] of table) {
    const key = entry && entry.commitKey
    if (typeof key !== 'string' || !key) continue
    let from = text.indexOf(key)
    while (from >= 0) {
      const after = text[from + key.length]
      if (after === undefined || !/\d/.test(after)) {
        if (key.length > bestLength) { best = index; bestLength = key.length }
        break
      }
      from = text.indexOf(key, from + 1)
    }
  }
  return best
}

/**
 * Resolve one proposition's evidence into a structured chain.
 *
 * @param {{claim?: string, ground?: {kind?: string, evidence?: string}}} proposition
 * @param {Map<number, object>} table from {@link buildProvenanceTable}
 * @param {number} position 0-based position of this proposition in its list
 * @returns {object|null} the provenance record, or null when it cannot exist
 */
export function resolveProvenance(proposition, table, position) {
  if (!table || table.size === 0) return null
  const evidence = proposition && proposition.ground ? proposition.ground.evidence : ''
  let cited = citedIndex(evidence)
  let target = cited !== null ? table.get(cited) : undefined
  if (!target) {
    // No usable `【n】` marker: the evidence may still name the commit key
    // outright, which is an exact identification rather than a guess.
    const byKey = keyIndexIn(evidence, table)
    if (byKey !== null) {
      target = table.get(byKey)
      cited = byKey
    }
  }
  let resolution = 'exact'
  if (!target) {
    // Deterministic, visible fallback: pair the proposition with the input at
    // its own position. This keeps a chain for every claim while recording that
    // the citation itself was not usable. `cited` below distinguishes "no
    // citation given" (null) from "cited something out of range" (a number),
    // so the two failure modes stay diagnosable without a third state.
    target = table.get(position + 1)
    if (!target) return null
    resolution = 'derived'
  }
  return {
    commitKey: target.commitKey,
    sessionId: target.sessionId,
    turn: target.turn,
    locator: { userSeq: target.userSeq, endSeq: target.endSeq },
    time: target.time,
    userTime: target.userTime,
    quote: target.quote,
    resolution,
    cited,
  }
}

/** True when a locator addresses a real event range in the session log. */
export function locatorResolvable(locator) {
  if (!locator || typeof locator !== 'object') return false
  const { userSeq, endSeq } = locator
  if (!Number.isFinite(userSeq)) return false
  if (!Number.isFinite(endSeq)) return false
  return endSeq >= userSeq
}

/**
 * Attach the structured chain to every proposition-shaped list of one
 * information object, and return the index actually used.
 *
 * `ground.evidence` is preserved verbatim: the client renders it and older
 * stored merges still carry only that field, so this is purely additive.
 *
 * @param {object} io information object (`propositions`, `negativeConstraints`, …)
 * @param {Map<number, object>} table
 * @returns {object} a new information object with provenance attached
 */
export function attachProvenance(io, table) {
  if (!io || typeof io !== 'object') return io
  const out = { ...io }
  for (const field of ['propositions', 'negativeConstraints']) {
    const list = Array.isArray(io[field]) ? io[field] : []
    out[field] = list.map((item, index) => {
      const provenance = resolveProvenance(item, table, index)
      if (!provenance) return item
      return { ...item, ground: { ...(item && item.ground ? item.ground : {}), provenance } }
    })
  }
  out.sourceIndex = [...table.values()].map((entry) => ({
    index: entry.index,
    commitKey: entry.commitKey,
    sessionId: entry.sessionId,
    turn: entry.turn,
    locator: { userSeq: entry.userSeq, endSeq: entry.endSeq },
    time: entry.time,
    quote: entry.quote,
  }))
  return out
}

/**
 * Reverse lookup: every proposition in one information object that traces back
 * to the given commit key. This is the "which claims rest on this commit?"
 * direction of the chain, used to audit an increment before merging it.
 *
 * @param {object} io
 * @param {string} commitKey
 * @returns {Array<{field: string, index: number, claim: string, resolution: string}>}
 */
export function propositionsFrom(io, commitKey) {
  const hits = []
  if (!io || typeof io !== 'object') return hits
  for (const field of ['propositions', 'negativeConstraints']) {
    const list = Array.isArray(io[field]) ? io[field] : []
    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {}
      const provenance = item.ground && item.ground.provenance
      if (!provenance || provenance.commitKey !== commitKey) continue
      hits.push({
        field,
        index: i,
        claim: String(item.claim || ''),
        resolution: provenance.resolution || 'unresolved',
      })
    }
  }
  return hits
}

/**
 * Summarise chain health for one information object: how many claims resolved
 * exactly, how many were derived onto a positional fallback, and how many have
 * no chain at all. Surfaced to the model so a weak citation is visible instead
 * of silently trusted.
 *
 * @param {object} io
 * @returns {{total: number, exact: number, derived: number, unresolved: number, ratio: number}}
 */
export function provenanceHealth(io) {
  let total = 0
  let exact = 0
  let derived = 0
  let unresolved = 0
  if (io && typeof io === 'object') {
    for (const field of ['propositions', 'negativeConstraints']) {
      const list = Array.isArray(io[field]) ? io[field] : []
      for (const item of list) {
        total++
        const provenance = item && item.ground && item.ground.provenance
        if (!provenance) { unresolved++; continue }
        if (provenance.resolution === 'exact') exact++
        else if (provenance.resolution === 'derived') derived++
        else unresolved++
      }
    }
  }
  return {
    total,
    exact,
    derived,
    unresolved,
    // Share of claims whose citation was usable as written. 1 when there is
    // nothing to verify, so an empty object is not reported as unhealthy.
    ratio: total === 0 ? 1 : exact / total,
  }
}

/**
 * One-line human/model-readable chain for a proposition, e.g.
 *   `session-abc:3 (turn 3, seq 42–57)`
 * @param {object} provenance
 * @returns {string}
 */
export function describeProvenance(provenance) {
  if (!provenance) return '（无溯源链）'
  const parts = [String(provenance.commitKey || '?')]
  if (provenance.turn !== null && provenance.turn !== undefined) parts.push('turn ' + provenance.turn)
  const locator = provenance.locator || {}
  if (locatorResolvable(locator)) parts.push('seq ' + locator.userSeq + '–' + locator.endSeq)
  const suffix = provenance.resolution && provenance.resolution !== 'exact' ? ' [' + provenance.resolution + ']' : ''
  return parts.join(', ') + suffix
}
