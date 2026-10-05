export const ENVELOPE_TYPES = Object.freeze([
  'task', 'status', 'question', 'answer', 'offer', 'accept',
  'merge-request', 'merge-decision', 'system',
])

export const WORKER_STATES = Object.freeze([
  'active', 'waiting', 'merge-requested', 'merging', 'rework', 'retired', 'failed',
])

export const REQUEST_STATES = Object.freeze([
  'awaiting-checkpoint', 'pending', 'approved', 'rejected', 'committing', 'committed', 'conflict', 'failed',
])

export function fail(code, detail) {
  return { ok: false, code, ...(detail === undefined ? {} : { detail }) }
}

export function memberIds(workflow, workers) {
  const ids = [workflow.mainSessionId]
  for (const worker of workers) if (worker.workflowId === workflow.id && worker.status !== 'retired') ids.push(worker.sessionId)
  return [...new Set(ids)]
}

export function roleOf(workflow, workers, sessionId) {
  if (!workflow || !sessionId) return null
  if (workflow.managerSessionId === sessionId) return 'manager'
  const worker = workers.find((item) => item.workflowId === workflow.id && item.sessionId === sessionId)
  return worker && worker.status !== 'retired' ? 'worker' : null
}

export function assertMember(workflow, workers, sessionId) {
  return roleOf(workflow, workers, sessionId) ? { ok: true } : fail('not-a-workflow-member')
}

export function assertManager(workflow, sessionId, epoch, now = Date.now()) {
  if (!workflow || workflow.status !== 'active') return fail('workflow-not-active')
  if (workflow.managerSessionId !== sessionId) return fail('manager-only')
  if (epoch !== undefined && Number(epoch) !== workflow.managerEpoch) return fail('stale-manager-epoch')
  if (Number(workflow.leaseUntil) <= now) return fail('manager-lease-expired')
  return { ok: true }
}

export function renewLease(workflow, now = Date.now()) {
  const leaseMs = Number.isFinite(workflow.leaseMs) && workflow.leaseMs >= 30_000 ? workflow.leaseMs : 300_000
  workflow.leaseUntil = now + leaseMs
  workflow.updatedAt = now
  return workflow.leaseUntil
}

export function takeover(workflow, workers, sessionId, now = Date.now()) {
  const member = assertMember(workflow, workers, sessionId)
  if (!member.ok) return member
  if (workflow.status !== 'active') return fail('workflow-not-active')
  if (Number(workflow.leaseUntil) > now) return fail('manager-lease-active')
  workflow.managerSessionId = sessionId
  workflow.managerEpoch = Number(workflow.managerEpoch || 0) + 1
  renewLease(workflow, now)
  return { ok: true, epoch: workflow.managerEpoch, leaseUntil: workflow.leaseUntil }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateEnvelope(envelope, workflow, workers) {
  if (!plainObject(envelope)) return fail('bad-envelope')
  if (!ENVELOPE_TYPES.includes(envelope.type)) return fail('bad-envelope-type')
  for (const key of ['id', 'workflowId', 'from', 'to', 'type']) {
    if (typeof envelope[key] !== 'string' || !envelope[key]) return fail('bad-envelope-field', key)
  }
  if (envelope.workflowId !== workflow.id) return fail('workflow-mismatch')
  if (!roleOf(workflow, workers, envelope.from) || !roleOf(workflow, workers, envelope.to)) return fail('non-member-endpoint')
  if (!Number.isSafeInteger(envelope.epoch) || envelope.epoch < 1 || envelope.epoch > workflow.managerEpoch) return fail('bad-envelope-epoch')
  if (!Number.isSafeInteger(envelope.createdAt) || envelope.createdAt < 0) return fail('bad-envelope-time')
  if (!plainObject(envelope.payload)) return fail('bad-envelope-payload')
  return { ok: true }
}

export function createEnvelope({ id, workflow, workers, from, to, type, payload, correlationId, inReplyTo, now = Date.now() }) {
  const envelope = {
    schemaVersion: 1,
    id,
    workflowId: workflow.id,
    epoch: workflow.managerEpoch,
    from,
    to,
    type,
    correlationId: correlationId || id,
    inReplyTo: inReplyTo || null,
    payload: plainObject(payload) ? payload : { value: payload },
    createdAt: now,
  }
  const valid = validateEnvelope(envelope, workflow, workers)
  return valid.ok ? { ok: true, envelope } : valid
}

export function authorizeOfferAccept(offer, workflow, workers, callerSessionId) {
  if (!offer || offer.workflowId !== workflow.id) return fail('offer-not-found')
  if (offer.status === 'accepted') return { ok: true, dedup: true }
  if (offer.status !== 'offered') return fail('offer-' + offer.status)
  if (offer.to !== callerSessionId) return fail('offer-recipient-only')
  if (!roleOf(workflow, workers, offer.from) || !roleOf(workflow, workers, offer.to)) return fail('non-member-endpoint')
  return { ok: true }
}

export function authorizeOfferMerge(offer, workflow, workers, callerSessionId) {
  if (!offer || offer.workflowId !== workflow.id) return fail('offer-not-found')
  if (offer.status !== 'accepted') return fail('offer-not-accepted')
  if (offer.to !== callerSessionId) return fail('offer-recipient-only')
  if (!roleOf(workflow, workers, offer.from) || !roleOf(workflow, workers, offer.to)) return fail('non-member-endpoint')
  return { ok: true, source: offer.from, target: offer.to, scope: offer.scope }
}

export function transitionRequest(request, next) {
  const allowed = {
    'awaiting-checkpoint': ['pending', 'failed'],
    pending: ['approved', 'rejected'],
    approved: ['committing', 'conflict', 'failed'],
    committing: ['committed', 'failed'],
    conflict: ['pending', 'rejected'],
    rejected: [], committed: [], failed: [],
  }
  if (!request || !REQUEST_STATES.includes(request.status)) return fail('bad-request-state')
  if (!(allowed[request.status] || []).includes(next)) return fail('invalid-request-transition', request.status + ' -> ' + next)
  request.status = next
  request.updatedAt = Date.now()
  return { ok: true }
}

export function safeSlug(value, fallback = 'worker') {
  const slug = String(value || '').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug || fallback
}

export function lastCompletedBoundary(events) {
  let boundary = -1
  for (let i = 0; i < (Array.isArray(events) ? events.length : 0); i++) {
    if (events[i] && events[i].type === 'turn/end') boundary = i
  }
  return boundary
}
