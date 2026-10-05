/**
 * Peer-session workflow plane (`workflow`) of dsh-graph-workflow.
 *
 * Originally dsh-agent-workflow, retired upstream after a factory-contract
 * crash (see the `setup` comments below) and because its separate per-worker
 * workspace conflicted with the information-layer workspace constraint.
 * Retained here in full: the leased-manager protocol, epoch fencing, the WAL
 * composite transaction, and all `workflow_*` tools.
 *
 * Mounted as a factory, not a Cordis plugin: the merged package registers ONE
 * plugin row and wires every plane from one entry, so this takes the shared
 * host context.
 */

import { randomUUID } from 'node:crypto'
import { GitRuntime, subprocessRunner } from './git-runtime.js'
import {
  assertManager, assertMember, authorizeOfferAccept, authorizeOfferMerge,
  createEnvelope, fail, lastCompletedBoundary, memberIds, renewLease, roleOf,
  safeSlug, takeover, transitionRequest,
} from './workflow-core.js'

export const workflowInject = [
  'sessionQuery', 'workspaceRegistry', 'storageDomain',
  'agents', 'sessions', 'agentDefaultModel', 'subprocess', 'webServer',
]

const DUCK = Object.freeze({ safeParse: () => ({ success: true }), parse: (value) => value })
const PLUGIN_ID = 'dsh-graph-workflow'
const DEFAULT_LEASE_MS = 300_000

export function installWorkflowPlane(ctx, graph) {
  const Q = ctx.sessionQuery
  const W = ctx.workspaceRegistry
  const git = new GitRuntime(subprocessRunner(ctx))
  const workflows = new Map()
  const workers = new Map()
  const events = new Map()
  const offers = new Map()
  const requests = new Map()
  const transactions = new Map()
  const handles = new Map()
  const tables = Object.create(null)
  let domain = null
  let domainError = null

  const ready = (async () => {
    domain = await ctx.storageDomain.open({
      name: 'agent_workflow', version: 0,
      tables: {
        workflows: { valueSchema: DUCK }, workers: { valueSchema: DUCK },
        events: { valueSchema: DUCK }, offers: { valueSchema: DUCK },
        requests: { valueSchema: DUCK }, transactions: { valueSchema: DUCK },
      },
    })
    for (const name of ['workflows', 'workers', 'events', 'offers', 'requests', 'transactions']) {
      tables[name] = domain.table(name)
      const target = { workflows, workers, events, offers, requests, transactions }[name]
      for (const [key, value] of tables[name].entries()) target.set(key, value)
    }
    graphHandle.invalidate()
    await recoverTransactions()
  })().catch((error) => {
    domainError = error
    console.error('[agent-workflow] storage initialization failed', error)
  })

  async function ensureReady() {
    await ready
    if (domainError) throw domainError
  }

  async function put(name, key, value) {
    await ensureReady()
    const map = { workflows, workers, events, offers, requests, transactions }[name]
    map.set(key, value)
    await tables[name].put(key, value)
  }

  function workerList(workflowId, includeRetired = true) {
    return [...workers.values()].filter((item) => item.workflowId === workflowId && (includeRetired || item.status !== 'retired'))
  }

  function workflowForSession(sessionId, includeClosed = false) {
    for (const workflow of workflows.values()) {
      if (!includeClosed && workflow.status !== 'active') continue
      if (workflow.mainSessionId === sessionId) return workflow
      if (workerList(workflow.id).some((item) => item.sessionId === sessionId)) return workflow
    }
    return null
  }

  function workerFor(workflowId, sessionId) {
    return workers.get(workflowId + ':' + sessionId) || null
  }

  function worktreeFor(workflow, sessionId) {
    if (sessionId === workflow.mainSessionId) return workflow.mainWorktree
    const worker = workerFor(workflow.id, sessionId)
    return worker && worker.worktreePath
  }

  function newId(prefix) {
    return prefix + '-' + randomUUID()
  }

  // The graph service is passed in, not injected: this package PROVIDES
  // `sessionGraph`, so declaring it in `inject` would be a self-dependency and
  // Cordis would park the whole plugin forever.
  const graphHandle = graph.registerCoordinator({
    resolveMembership({ sessionId }) {
      const workflow = workflowForSession(sessionId, true)
      if (!workflow) return null
      return {
        graphId: workflow.id,
        label: workflow.name,
        sessionIds: [workflow.mainSessionId, ...workerList(workflow.id, true).map((item) => item.sessionId)],
      }
    },
    guardMutation({ source, target }) {
      const workflow = workflowForSession(target, false) || workflowForSession(source, false)
      return workflow ? { allow: false, code: 'workflow-authorization-required' } : { allow: true }
    },
  })

  ctx.effect(() => async () => {
    graphHandle.release()
    const pending = [...handles.values()].map((handle) => handle.dispose().catch(() => {}))
    handles.clear()
    await Promise.allSettled(pending)
    const closing = domain
    domain = null
    if (closing) await closing.close().catch(() => {})
  }, 'dsh-agent-workflow: lifecycle')

  function callingAgent(exec) {
    const agent = exec && exec.agent
    return agent && agent.session && typeof agent.session.id === 'string' ? agent : null
  }

  function modelMessage(text, form = 'relay') {
    return {
      id: newId('awf-msg'),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN_ID, form },
    }
  }

  function eventText(envelope) {
    const payload = envelope.payload || {}
    return [
      '[Agent Workflow message]',
      'workflow=' + envelope.workflowId + ' epoch=' + envelope.epoch,
      'from=' + envelope.from + ' type=' + envelope.type + ' id=' + envelope.id,
      payload.text || payload.summary || payload.task || JSON.stringify(payload),
      'Use workflow_status to inspect current authority and state before acting.',
    ].join('\n')
  }

  async function persistEvent(record) {
    await put('events', record.id, record)
  }

  async function resumeAgent(workflow, sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) return live
    const worker = workerFor(workflow.id, sessionId)
    const mainLive = ctx.agents.get(workflow.mainSessionId)
    const presetId = worker ? worker.agentPreset : workflow.agentPreset
    const selection = worker && worker.agentOptions ? worker.agentOptions : workflow.agentOptions
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: selection,
      // `setup` composes the scoped world and must return NOTHING (or an
      // `AgentSetupCommit`). The factory runs
      //   (await setup?.(agent.ctx, agent))?.commit()
      // and optional chaining only guards null/undefined — returning the preset
      // id from `composeFrom` (a truthy string) or the preset object from
      // `mount` sends a non-commit value into `.commit()`, which is the
      // `(intermediate value)?.commit is not a function` crash that retired the
      // upstream dsh-agent-workflow. Block body, no return value.
      setup: async (agentCtx) => {
        const presets = ctx.get('agentPresets')
        if (!presets) return
        if (mainLive) { presets.composeFrom(agentCtx, mainLive.ctx); return }
        await presets.mount(agentCtx, presetId)
      },
    })
    handles.set(sessionId, handle)
    return handle.agent
  }

  async function deliver(workflow, sessionId, envelope) {
    try {
      const agent = await resumeAgent(workflow, sessionId)
      agent.followup(modelMessage(eventText(envelope)))
      return { ok: true }
    } catch (error) {
      const failure = {
        schemaVersion: 1, id: newId('evt'), workflowId: workflow.id,
        kind: 'delivery-failed', envelopeId: envelope.id, sessionId,
        detail: String(error && error.message || error), createdAt: Date.now(),
      }
      await persistEvent(failure).catch(() => {})
      return fail('delivery-failed', failure.detail)
    }
  }

  async function sendProtocol(workflow, from, to, type, payload, options = {}) {
    const made = createEnvelope({
      id: newId('env'), workflow, workers: workerList(workflow.id),
      from, to, type, payload, correlationId: options.correlationId,
      inReplyTo: options.inReplyTo,
    })
    if (!made.ok) return made
    await persistEvent(made.envelope)
    const delivery = await deliver(workflow, to, made.envelope)
    return { ok: true, envelope: made.envelope, delivery }
  }

  async function createWorkflow(agent, args = {}) {
    await ensureReady()
    if (workflowForSession(agent.id, false)) return fail('already-in-workflow')
    const cwd = agent.session.header && agent.session.header.cwd
    if (!cwd) return fail('workspace-required')
    const repo = await git.inspect(cwd)
    if (!repo.ok) return repo
    if (!repo.clean) return fail('main-worktree-dirty', repo.status)
    const now = Date.now()
    const selection = { ...agent.options }
    const presets = ctx.get('agentPresets')
    const workflow = {
      schemaVersion: 1,
      id: newId('wf'),
      name: String(args.name || '').trim().slice(0, 100) || 'Agent workflow',
      status: 'active',
      mainSessionId: agent.id,
      managerSessionId: agent.id,
      managerEpoch: 1,
      leaseMs: Number.isSafeInteger(args.leaseSeconds) && args.leaseSeconds >= 30 ? args.leaseSeconds * 1000 : DEFAULT_LEASE_MS,
      leaseUntil: now + (Number.isSafeInteger(args.leaseSeconds) && args.leaseSeconds >= 30 ? args.leaseSeconds * 1000 : DEFAULT_LEASE_MS),
      repoRoot: repo.root,
      mainWorktree: cwd,
      mainBranch: repo.branch,
      mainGitHead: repo.head,
      agentOptions: selection,
      agentPreset: presets ? presets.composedPreset(agent.ctx) : undefined,
      createdAt: now,
      updatedAt: now,
    }
    await put('workflows', workflow.id, workflow)
    await persistEvent({ schemaVersion: 1, id: newId('evt'), workflowId: workflow.id, kind: 'workflow-created', actor: agent.id, epoch: 1, createdAt: now })
    graphHandle.invalidate(agent.id)
    return { ok: true, workflow }
  }

  async function requireWorkflow(agent) {
    await ensureReady()
    const workflow = workflowForSession(agent.id, false)
    return workflow ? { ok: true, workflow, workers: workerList(workflow.id) } : fail('not-in-workflow')
  }

  async function spawnWorker(agent, args = {}) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const { workflow } = found
    const epoch = workflow.managerEpoch
    const authority = assertManager(workflow, agent.id, epoch)
    if (!authority.ok) return authority
    renewLease(workflow)
    await put('workflows', workflow.id, workflow)
    if (workerList(workflow.id, false).length >= 8) return fail('worker-limit-reached')
    const task = String(args.task || '').trim()
    if (!task) return fail('task-required')
    const name = String(args.name || '').trim().slice(0, 80) || 'worker'
    const mainSnapshot = await Q.readSession(workflow.mainSessionId)
    const boundary = lastCompletedBoundary(mainSnapshot.events)
    const seed = boundary >= 0 ? mainSnapshot.events.slice(0, boundary + 1) : []
    const mainGit = await git.inspect(workflow.mainWorktree)
    if (!mainGit.ok) return mainGit
    if (!mainGit.clean) return fail('main-worktree-dirty', mainGit.status)
    const token = safeSlug(name) + '-' + randomUUID().slice(0, 8)
    const sessionId = 'session-awf-' + randomUUID()
    const branch = 'dsh-workflow/' + safeSlug(workflow.name, 'workflow') + '/' + token
    const worktreePath = git.workerPath(workflow.repoRoot, safeSlug(workflow.id), token)
    const added = await git.createWorktree({ repoRoot: workflow.repoRoot, path: worktreePath, branch, startOid: mainGit.head })
    if (!added.ok) return added
    const now = Date.now()
    const worker = {
      schemaVersion: 1, workflowId: workflow.id, sessionId, name,
      role: 'worker', parentSessionId: workflow.mainSessionId,
      forkBoundary: boundary, seedLength: seed.length,
      worktreePath, branch, baseGitHead: mainGit.head,
      status: 'creating', agentOptions: { ...agent.options },
      agentPreset: workflow.agentPreset, createdAt: now, updatedAt: now,
    }
    await put('workers', workflow.id + ':' + sessionId, worker)
    graphHandle.invalidate()
    let createdHandle = null
    try {
      const workspace = await W.create(worktreePath, name)
      const presets = ctx.get('agentPresets')
      const handle = await ctx.agents.create({
        sessionId,
        // Fork lineage is expressed as the seeded-header marker plus the exact
        // inherited prefix length. `seedLength` is NOT a session field: the
        // creation metadata is whitelisted (so it would be dropped silently,
        // leaving isSeeded false) and the persistence validator rejects a
        // stored `seedLength` outright.
        meta: {
          cwd: worktreePath,
          parentSession: workflow.mainSessionId,
          isSeeded: true,
          ...(workflow.agentPreset ? { agentPreset: workflow.agentPreset } : {}),
        },
        seed,
        inheritedEventCount: seed.length,
        agentOptions: { ...agent.options },
        // Same contract as the resume path above: compose only, return nothing.
        setup: async (agentCtx) => {
          if (!presets) return
          presets.composeFrom(agentCtx, agent.ctx)
        },
      })
      createdHandle = handle
      handles.set(sessionId, handle)
      await workspace.attachSession(sessionId)
      if (!assertManager(workflow, agent.id, epoch).ok) throw new Error('manager authority changed during worker creation')
      worker.status = 'active'
      worker.updatedAt = Date.now()
      await put('workers', workflow.id + ':' + sessionId, worker)
      graphHandle.invalidate()
      handle.agent.followup(modelMessage([
        '[Agent Workflow assignment]',
        'You are an independent peer worker, not a subagent.',
        'workflow=' + workflow.id + ' manager=' + workflow.managerSessionId + ' epoch=' + workflow.managerEpoch,
        'worker=' + sessionId + ' branch=' + branch,
        'Task: ' + task,
        'Commit artifact changes to your branch. Communicate with workflow_send/workflow_offer. When deliverable, call workflow_request_merge; it becomes pending only after your current turn closes.',
      ].join('\n'), 'instructions'))
      await persistEvent({ schemaVersion: 1, id: newId('evt'), workflowId: workflow.id, kind: 'worker-created', actor: agent.id, workerSessionId: sessionId, task, createdAt: Date.now() })
      return { ok: true, worker }
    } catch (error) {
      if (createdHandle) {
        handles.delete(sessionId)
        await createdHandle.dispose().catch(() => {})
      }
      worker.status = 'failed'
      worker.failure = String(error && error.message || error)
      worker.updatedAt = Date.now()
      await put('workers', workflow.id + ':' + sessionId, worker).catch(() => {})
      await git.removeWorktree(workflow.repoRoot, worktreePath).catch(() => {})
      return fail('worker-create-failed', worker.failure)
    }
  }

  async function send(agent, args = {}) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const type = ['task', 'status', 'question', 'answer'].includes(args.type) ? args.type : 'status'
    const to = String(args.to || '')
    const text = String(args.text || '').trim()
    if (!text) return fail('message-required')
    return await sendProtocol(found.workflow, agent.id, to, type, { text }, { correlationId: args.correlationId, inReplyTo: args.inReplyTo })
  }

  async function createOffer(agent, args = {}) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const { workflow } = found
    const to = String(args.to || '')
    if (to === agent.id) return fail('self-offer')
    if (!roleOf(workflow, found.workers, to)) return fail('non-member-endpoint')
    const scope = ['information', 'artifacts', 'both'].includes(args.scope) ? args.scope : 'information'
    const now = Date.now()
    const offer = {
      schemaVersion: 1, id: newId('offer'), workflowId: workflow.id,
      from: agent.id, to, scope, summary: String(args.summary || '').trim().slice(0, 2000),
      status: 'offered', createdAt: now, updatedAt: now,
    }
    await put('offers', offer.id, offer)
    const sent = await sendProtocol(workflow, agent.id, to, 'offer', { offerId: offer.id, scope, summary: offer.summary }, { correlationId: offer.id })
    return { ok: true, offer, delivery: sent.delivery }
  }

  async function acceptOffer(agent, args = {}) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const offer = offers.get(String(args.offerId || ''))
    const allowed = authorizeOfferAccept(offer, found.workflow, found.workers, agent.id)
    if (!allowed.ok || allowed.dedup) return allowed.ok ? { ok: true, offer, dedup: true } : allowed
    offer.status = 'accepted'
    offer.acceptedAt = Date.now()
    offer.updatedAt = offer.acceptedAt
    await put('offers', offer.id, offer)
    const sent = await sendProtocol(found.workflow, agent.id, offer.from, 'accept', { offerId: offer.id }, { correlationId: offer.id })
    return { ok: true, offer, delivery: sent.delivery }
  }

  function activeTransaction(workflowId) {
    return [...transactions.values()].find((tx) => tx.workflowId === workflowId && ['committing', 'recovering'].includes(tx.status)) || null
  }

  async function prepareTransaction({ workflow, source, target, scope, idempotencyKey, kind, authority }) {
    const blocked = activeTransaction(workflow.id)
    if (blocked) return fail('workflow-transaction-busy', blocked.id)
    const existing = [...transactions.values()].find((tx) => tx.idempotencyKey === idempotencyKey)
    if (existing) return { ok: true, transaction: existing, dedup: true }
    const wantsInfo = scope !== 'artifacts'
    const wantsGit = scope !== 'information'
    let infoPreparation = null
    let infoSkipped = null
    if (wantsInfo) {
      const prepared = await graphHandle.prepareMerge({
        callerSessionId: target, source, target,
        idempotencyKey: 'awf:' + idempotencyKey,
      })
      if (prepared.ok && prepared.preparation) infoPreparation = prepared.preparation.id
      else if (prepared.ok && prepared.alreadyCommitted) infoSkipped = 'already-committed'
      else if (['already-contained', 'no-effective-increment'].includes(prepared.code)) infoSkipped = prepared.code
      else return prepared
    }
    let gitPlan = null
    if (wantsGit) {
      const sourceCwd = worktreeFor(workflow, source)
      const targetCwd = worktreeFor(workflow, target)
      if (!sourceCwd || !targetCwd) {
        if (infoPreparation) await graphHandle.abortMerge({ preparationId: infoPreparation }).catch(() => {})
        return fail('worktree-not-found')
      }
      gitPlan = await git.preflightMerge({ sourceCwd, targetCwd })
      if (!gitPlan.ok) {
        if (infoPreparation) await graphHandle.abortMerge({ preparationId: infoPreparation }).catch(() => {})
        return gitPlan
      }
    }
    const now = Date.now()
    const transaction = {
      schemaVersion: 1, id: newId('tx'), idempotencyKey, workflowId: workflow.id,
      kind, source, target, scope, status: 'prepared',
      managerEpoch: authority ? authority.epoch : workflow.managerEpoch,
      infoPreparation, infoSkipped, gitPlan,
      createdAt: now, updatedAt: now,
    }
    await put('transactions', transaction.id, transaction)
    return { ok: true, transaction }
  }

  async function commitTransaction(workflow, transaction, authorityCheck) {
    if (transaction.status === 'committed') return { ok: true, transaction, dedup: true }
    if (!['prepared', 'recovering'].includes(transaction.status)) return fail('transaction-' + transaction.status)
    if (authorityCheck) {
      const check = authorityCheck()
      if (!check.ok) return check
    }
    transaction.status = 'committing'
    transaction.updatedAt = Date.now()
    await put('transactions', transaction.id, transaction)
    if (transaction.gitPlan && !transaction.gitCommit) {
      const result = await git.commitMerge({
        targetCwd: worktreeFor(workflow, transaction.target),
        sourceHead: transaction.gitPlan.sourceHead,
        expectedTargetHead: transaction.gitPlan.targetHead,
        message: 'dsh workflow merge ' + transaction.source + ' -> ' + transaction.target,
      })
      if (!result.ok) {
        transaction.status = result.code === 'git-conflict' ? 'conflict' : 'failed'
        transaction.failure = result
        transaction.updatedAt = Date.now()
        await put('transactions', transaction.id, transaction)
        if (transaction.infoPreparation) await graphHandle.abortMerge({ preparationId: transaction.infoPreparation }).catch(() => {})
        return result
      }
      transaction.gitCommit = result.head
      transaction.gitPreviousHead = result.previousHead
      if (transaction.target === workflow.mainSessionId) workflow.mainGitHead = result.head
      transaction.updatedAt = Date.now()
      await put('transactions', transaction.id, transaction)
      if (transaction.target === workflow.mainSessionId) await put('workflows', workflow.id, workflow)
    }
    if (authorityCheck) {
      const check = authorityCheck()
      if (!check.ok) {
        transaction.status = 'recovering'
        transaction.failure = check
        await put('transactions', transaction.id, transaction)
        return check
      }
    }
    if (transaction.infoPreparation && !transaction.infoMerge) {
      const info = await graphHandle.commitMerge({ preparationId: transaction.infoPreparation })
      if (!info.ok) {
        transaction.status = transaction.gitCommit ? 'recovering' : 'failed'
        transaction.failure = info
        transaction.updatedAt = Date.now()
        await put('transactions', transaction.id, transaction)
        return info
      }
      transaction.infoMerge = info.merge
    }
    transaction.status = 'committed'
    transaction.committedAt = Date.now()
    transaction.updatedAt = transaction.committedAt
    await put('transactions', transaction.id, transaction)
    graphHandle.invalidate(transaction.target)
    return { ok: true, transaction }
  }

  async function mergeOffer(agent, args = {}) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const offer = offers.get(String(args.offerId || ''))
    if (offer && offer.mergeTransactionId) {
      const previous = transactions.get(offer.mergeTransactionId)
      if (previous && previous.status === 'committed') return { ok: true, offer, transaction: previous, dedup: true }
    }
    const allowed = authorizeOfferMerge(offer, found.workflow, found.workers, agent.id)
    if (!allowed.ok) return allowed
    if (offer.mergeTransactionId) return fail('offer-merge-incomplete')
    const prepared = await prepareTransaction({
      workflow: found.workflow, source: allowed.source, target: allowed.target,
      scope: allowed.scope, idempotencyKey: 'offer:' + offer.id, kind: 'peer-offer',
    })
    if (!prepared.ok) return prepared
    offer.mergeTransactionId = prepared.transaction.id
    offer.status = 'merging'
    await put('offers', offer.id, offer)
    const committed = await commitTransaction(found.workflow, prepared.transaction)
    offer.status = committed.ok ? 'merged' : 'accepted'
    offer.updatedAt = Date.now()
    await put('offers', offer.id, offer)
    return committed.ok ? { ok: true, offer, transaction: committed.transaction } : committed
  }

  async function requestMerge(agent, args = {}) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const worker = workerFor(found.workflow.id, agent.id)
    if (!worker || worker.status === 'retired') return fail('worker-only')
    const existing = [...requests.values()].find((item) => item.workflowId === found.workflow.id && item.workerSessionId === agent.id && ['awaiting-checkpoint', 'pending', 'approved', 'committing'].includes(item.status))
    if (existing) return { ok: true, request: existing, dedup: true }
    const now = Date.now()
    const request = {
      schemaVersion: 1, id: newId('mr'), workflowId: found.workflow.id,
      workerSessionId: agent.id, targetSessionId: found.workflow.mainSessionId,
      summary: String(args.summary || '').trim().slice(0, 4000),
      scope: ['information', 'artifacts', 'both'].includes(args.scope) ? args.scope : 'both',
      status: 'awaiting-checkpoint', readyAfterSeq: agent.session.seq,
      createdAt: now, updatedAt: now,
    }
    worker.status = 'merge-requested'
    worker.updatedAt = now
    await put('workers', found.workflow.id + ':' + agent.id, worker)
    await put('requests', request.id, request)
    return { ok: true, request, note: 'The manager will be notified after this turn reaches turn/end.' }
  }

  async function finalizeMergeRequests(session, event) {
    if (!event || event.type !== 'turn/end') return
    await ensureReady()
    for (const request of requests.values()) {
      if (request.workerSessionId !== session.id || request.status !== 'awaiting-checkpoint' || event.seq < request.readyAfterSeq) continue
      const workflow = workflows.get(request.workflowId)
      if (!workflow || workflow.status !== 'active') continue
      const moved = transitionRequest(request, 'pending')
      if (!moved.ok) continue
      request.sourceCheckpointSeq = event.seq
      await put('requests', request.id, request)
      await sendProtocol(workflow, request.workerSessionId, workflow.managerSessionId, 'merge-request', {
        requestId: request.id, summary: request.summary, scope: request.scope,
      }, { correlationId: request.id })
    }
  }

  ctx.on('session/event', (session, event) => {
    finalizeMergeRequests(session, event).catch((error) => console.error('[agent-workflow] checkpoint finalization failed', error))
  })

  async function decideMerge(agent, args = {}) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const { workflow } = found
    const epoch = workflow.managerEpoch
    const authority = assertManager(workflow, agent.id, epoch)
    if (!authority.ok) return authority
    renewLease(workflow)
    await put('workflows', workflow.id, workflow)
    const request = requests.get(String(args.requestId || ''))
    if (!request || request.workflowId !== workflow.id) return fail('merge-request-not-found')
    if (request.status === 'committed') return { ok: true, request, transaction: transactions.get(request.transactionId), dedup: true }
    if (request.status !== 'pending') return fail('merge-request-' + request.status)
    if (args.approve !== true) {
      transitionRequest(request, 'rejected')
      request.reason = String(args.reason || '').trim().slice(0, 2000)
      await put('requests', request.id, request)
      const worker = workerFor(workflow.id, request.workerSessionId)
      if (worker) { worker.status = 'rework'; worker.updatedAt = Date.now(); await put('workers', workflow.id + ':' + worker.sessionId, worker) }
      await sendProtocol(workflow, agent.id, request.workerSessionId, 'merge-decision', { requestId: request.id, approved: false, reason: request.reason }, { correlationId: request.id })
      return { ok: true, request }
    }
    transitionRequest(request, 'approved')
    await put('requests', request.id, request)
    const prepared = await prepareTransaction({
      workflow, source: request.workerSessionId, target: workflow.mainSessionId,
      scope: request.scope, idempotencyKey: 'request:' + request.id,
      kind: 'worker-to-main', authority: { epoch },
    })
    if (!prepared.ok) {
      request.status = prepared.code === 'git-conflict' ? 'conflict' : 'failed'
      request.failure = prepared
      await put('requests', request.id, request)
      const worker = workerFor(workflow.id, request.workerSessionId)
      if (worker) { worker.status = 'rework'; await put('workers', workflow.id + ':' + worker.sessionId, worker) }
      await sendProtocol(workflow, agent.id, request.workerSessionId, 'merge-decision', { requestId: request.id, approved: false, reason: prepared.code }, { correlationId: request.id })
      return prepared
    }
    request.transactionId = prepared.transaction.id
    transitionRequest(request, 'committing')
    await put('requests', request.id, request)
    const committed = await commitTransaction(workflow, prepared.transaction, () => assertManager(workflow, agent.id, epoch))
    if (!committed.ok) {
      request.status = prepared.transaction.status === 'conflict' ? 'conflict' : 'failed'
      request.failure = committed
      await put('requests', request.id, request)
      return committed
    }
    transitionRequest(request, 'committed')
    request.committedAt = Date.now()
    await put('requests', request.id, request)
    await sendProtocol(workflow, agent.id, request.workerSessionId, 'merge-decision', { requestId: request.id, approved: true, transactionId: prepared.transaction.id }, { correlationId: request.id })
    const worker = workerFor(workflow.id, request.workerSessionId)
    if (worker) {
      worker.status = 'retired'
      worker.retiredAt = Date.now()
      worker.updatedAt = worker.retiredAt
      await put('workers', workflow.id + ':' + worker.sessionId, worker)
      const handle = handles.get(worker.sessionId)
      if (handle) {
        const live = handle.agent
        live.whenIdle().then(async () => {
          if (handles.get(worker.sessionId) !== handle) return
          handles.delete(worker.sessionId)
          await handle.dispose().catch(() => {})
        }).catch(() => {})
      }
      await W.archiveSession(worker.sessionId).catch(() => {})
    }
    graphHandle.invalidate()
    return { ok: true, request, transaction: committed.transaction }
  }

  async function heartbeat(agent) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const authority = assertManager(found.workflow, agent.id, found.workflow.managerEpoch)
    if (!authority.ok) return authority
    renewLease(found.workflow)
    await put('workflows', found.workflow.id, found.workflow)
    return { ok: true, epoch: found.workflow.managerEpoch, leaseUntil: found.workflow.leaseUntil }
  }

  async function takeOver(agent) {
    const found = await requireWorkflow(agent)
    if (!found.ok) return found
    const result = takeover(found.workflow, found.workers, agent.id)
    if (!result.ok) return result
    await put('workflows', found.workflow.id, found.workflow)
    await persistEvent({ schemaVersion: 1, id: newId('evt'), workflowId: found.workflow.id, kind: 'manager-takeover', actor: agent.id, epoch: result.epoch, createdAt: Date.now() })
    return result
  }

  async function stateFor(sessionId) {
    await ensureReady()
    const workflow = workflowForSession(sessionId, true)
    if (!workflow) return fail('not-in-workflow')
    const members = [
      {
        sessionId: workflow.mainSessionId,
        name: 'main', role: workflow.managerSessionId === workflow.mainSessionId ? 'manager' : 'main',
        status: ctx.agents.get(workflow.mainSessionId)?.status || 'cold',
        branch: workflow.mainBranch, worktreePath: workflow.mainWorktree,
      },
      ...workerList(workflow.id, true).map((worker) => ({
        sessionId: worker.sessionId, name: worker.name,
        role: workflow.managerSessionId === worker.sessionId ? 'manager' : 'worker',
        status: worker.status, runtimeStatus: ctx.agents.get(worker.sessionId)?.status || 'cold',
        branch: worker.branch, worktreePath: worker.worktreePath,
      })),
    ]
    return {
      ok: true,
      workflow: { ...workflow, role: roleOf(workflow, workerList(workflow.id), sessionId), leaseExpired: workflow.leaseUntil <= Date.now() },
      members,
      offers: [...offers.values()].filter((item) => item.workflowId === workflow.id).sort((a, b) => b.createdAt - a.createdAt),
      mergeRequests: [...requests.values()].filter((item) => item.workflowId === workflow.id).sort((a, b) => b.createdAt - a.createdAt),
      transactions: [...transactions.values()].filter((item) => item.workflowId === workflow.id).sort((a, b) => b.createdAt - a.createdAt),
      events: [...events.values()].filter((item) => item.workflowId === workflow.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
      generatedAt: Date.now(),
    }
  }

  async function recoverTransactions() {
    for (const transaction of transactions.values()) {
      if (!['committing', 'recovering'].includes(transaction.status)) continue
      const workflow = workflows.get(transaction.workflowId)
      if (!workflow) continue
      transaction.status = 'recovering'
      await tables.transactions.put(transaction.id, transaction)
      if (transaction.gitPlan && !transaction.gitCommit) {
        const recovered = await git.recoverMerge({
          targetCwd: worktreeFor(workflow, transaction.target),
          plan: transaction.gitPlan,
          message: 'dsh workflow recovery ' + transaction.source + ' -> ' + transaction.target,
        })
        if (!recovered.ok) {
          transaction.failure = recovered
          transaction.updatedAt = Date.now()
          await tables.transactions.put(transaction.id, transaction)
          continue
        }
        transaction.gitCommit = recovered.head
        transaction.gitPreviousHead = recovered.previousHead
        await tables.transactions.put(transaction.id, transaction)
      }
      if (transaction.infoPreparation && !transaction.infoMerge) {
        const info = await graphHandle.commitMerge({ preparationId: transaction.infoPreparation })
        if (!info.ok) {
          transaction.failure = info
          transaction.updatedAt = Date.now()
          await tables.transactions.put(transaction.id, transaction)
          continue
        }
        transaction.infoMerge = info.merge
      }
      transaction.status = 'committed'
      transaction.committedAt = Date.now()
      transaction.updatedAt = transaction.committedAt
      await tables.transactions.put(transaction.id, transaction)
    }
  }

  function frameFor(sessionId) {
    const workflow = workflowForSession(sessionId, false)
    if (!workflow) return ''
    const list = workerList(workflow.id)
    const role = roleOf(workflow, list, sessionId)
    const pending = [...requests.values()].filter((item) => item.workflowId === workflow.id && item.status === 'pending').length
    return [
      '【Agent Workflow】workflow=' + workflow.id + '；你的角色=' + role + '；manager=' + workflow.managerSessionId + '；epoch=' + workflow.managerEpoch + '。',
      '成员是彼此并列的持久 session，不是 subagent。通信必须使用 workflow_* typed protocol；大带宽共享必须先 offer/accept。',
      role === 'manager'
        ? '你独占 managed main 的审批权。待审批 merge request=' + pending + '；定期调用 workflow_heartbeat 续租。'
        : '完成工件后先 commit 当前 Git branch，再调用 workflow_request_merge；请求会在本 turn 结束后提交给 manager。',
      '直接调用 session_graph_merge 会被拒绝；所有 managed merge 必须经过本 workflow。',
    ].join('\n')
  }

  function output() {
    return { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  }

  function tool(name, description, parameters, execute) {
    return { name, description, parameters, output: output(), timeoutMs: 180000, execute }
  }

  const tools = [
    tool('workflow_create', '把当前顶层 session 的当前 Git branch 注册为 managed main，并成为 epoch=1 的 manager。', {
      type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, leaseSeconds: { type: 'integer', minimum: 30 } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await createWorkflow(agent, args) : fail('no-agent') }),
    tool('workflow_spawn_worker', 'manager 从 main 最近完成的 turn 分叉一个并列 worker session，并为它创建独立 Git worktree/branch。', {
      type: 'object', additionalProperties: false, required: ['name', 'task'], properties: { name: { type: 'string' }, task: { type: 'string' } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await spawnWorker(agent, args) : fail('no-agent') }),
    tool('workflow_send', '向 workflow 内另一个 peer 发送 typed 小带宽消息。', {
      type: 'object', additionalProperties: false, required: ['to', 'text'], properties: { to: { type: 'string' }, type: { type: 'string', enum: ['task', 'status', 'question', 'answer'] }, text: { type: 'string' }, correlationId: { type: 'string' }, inReplyTo: { type: 'string' } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await send(agent, args) : fail('no-agent') }),
    tool('workflow_offer', '向 peer 提出资源共享 offer；接收方接受后才形成 merge 授权。', {
      type: 'object', additionalProperties: false, required: ['to', 'summary'], properties: { to: { type: 'string' }, summary: { type: 'string' }, scope: { type: 'string', enum: ['information', 'artifacts', 'both'] } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await createOffer(agent, args) : fail('no-agent') }),
    tool('workflow_accept_offer', '仅 offer 接收方可接受，写入可审计握手。', {
      type: 'object', additionalProperties: false, required: ['offerId'], properties: { offerId: { type: 'string' } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await acceptOffer(agent, args) : fail('no-agent') }),
    tool('workflow_merge_offer', '在已接受的 offer 上执行授权范围内的 peer merge。', {
      type: 'object', additionalProperties: false, required: ['offerId'], properties: { offerId: { type: 'string' } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await mergeOffer(agent, args) : fail('no-agent') }),
    tool('workflow_request_merge', 'worker 请求汇入 managed main；当前 turn 结束后才进入 manager 审批队列。', {
      type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' }, scope: { type: 'string', enum: ['information', 'artifacts', 'both'] } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await requestMerge(agent, args) : fail('no-agent') }),
    tool('workflow_decide_merge', '仅当前 manager epoch 可批准或拒绝 worker 汇入；批准会执行 Git+信息 DAG 复合事务。', {
      type: 'object', additionalProperties: false, required: ['requestId', 'approve'], properties: { requestId: { type: 'string' }, approve: { type: 'boolean' }, reason: { type: 'string' } },
    }, async (args, exec) => { const agent = callingAgent(exec); return agent ? await decideMerge(agent, args) : fail('no-agent') }),
    tool('workflow_status', '查看 workflow 成员、manager epoch/lease、offers、merge requests、transactions 与最近事件。', {
      type: 'object', additionalProperties: false, properties: {},
    }, async (_args, exec) => { const agent = callingAgent(exec); return agent ? await stateFor(agent.id) : fail('no-agent') }),
    tool('workflow_heartbeat', '当前 manager 续租控制面 lease。', {
      type: 'object', additionalProperties: false, properties: {},
    }, async (_args, exec) => { const agent = callingAgent(exec); return agent ? await heartbeat(agent) : fail('no-agent') }),
    tool('workflow_takeover', 'lease 过期后，由仍活跃的 peer 接管 manager；epoch 单调递增并 fencing 旧 manager。', {
      type: 'object', additionalProperties: false, properties: {},
    }, async (_args, exec) => { const agent = callingAgent(exec); return agent ? await takeOver(agent) : fail('no-agent') }),
  ]

  function registerAgent(agent) {
    if (!agent || !agent.ctx || !agent.session) return
    try { agent.ctx.systemPrompt.section({ name: 'plugin:agent-workflow', order: 96, text: () => frameFor(agent.id) }) }
    catch (error) { console.error('[agent-workflow] prompt section failed', error) }
    for (const item of tools) {
      try { agent.ctx.tools.register(item) }
      catch (error) { console.error('[agent-workflow] tool registration failed', item.name, error) }
    }
  }

  ctx.on('agent/created', (payload) => registerAgent(payload && payload.agent))
  for (const agent of ctx.agents.list()) registerAgent(agent)

  function isLoopback(req) {
    const address = req.socket && req.socket.remoteAddress
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }
  function json(res, status, value) {
    try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
    catch { /* disconnected */ }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/awf',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' })
      let url
      try { url = new URL(req.url, 'http://localhost') } catch { return json(res, 400, { error: 'bad-url' }) }
      if (req.method === 'GET' && url.pathname === '/awf/state') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return json(res, 400, { error: 'bad-args' })
        try { return json(res, 200, await stateFor(sessionId)) }
        catch (error) { return json(res, 500, { error: 'state-failed', detail: String(error && error.message || error) }) }
      }
      return json(res, 404, { error: 'not-found' })
    },
  }), 'dsh-agent-workflow: /awf routes')

  return { stateFor, createWorkflow, spawnWorker, send, createOffer, acceptOffer, mergeOffer, requestMerge, decideMerge }
}
