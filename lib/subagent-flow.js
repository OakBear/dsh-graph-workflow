import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GitRuntime, subprocessRunner } from './git-runtime.js'

export const subagentFlowInject = ['sessionGraph', 'sessionQuery', 'workspaceRegistry', 'agents', 'subagents', 'subprocess']

const PLUGIN_ID = 'dsh-graph-workflow'
const MAX_HOPS = 64
const TEXT_CAP = 4000

function fail(code, detail) {
  return { ok: false, code, ...(detail === undefined ? {} : { detail }) }
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
}

function safeSlug(value, fallback = 'worker') {
  const slug = String(value || '').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug || fallback
}

function textOf(content) {
  let out = ''
  for (const block of Array.isArray(content) ? content : []) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Same-session subagent workflow plane (`subagentFlow`) of dsh-graph-workflow.
 *
 * Originally dsh-subagent-workflow. Retained in full: the permissive
 * coordinator policy, the worktree/ledger artifact zones, the descendant and
 * same-workspace guards, the manager/worker prompt frames, the report-receipt
 * protocol, and all `swf_*` tools.
 *
 * Mounted as a factory, not a Cordis plugin: the merged package registers ONE
 * plugin row and wires every plane from one entry.
 */

export function installSubagentFlowPlane(ctx, graph) {
  const Q = ctx.sessionQuery
  const W = ctx.workspaceRegistry
  const SUB = ctx.subagents
  const git = new GitRuntime(subprocessRunner(ctx))

  // Permissive coordinator policy: resolveMembership falls through to the
  // workspace closure in the graph plane (no member replacement); guardMutation
  // never blocks the native session_graph_merge tools. Registration exists to
  // hold the trusted seam capability for swf_integrate.
  //
  // The merged package hosts this policy ALONGSIDE the peer-session plane's
  // restrictive one; the graph plane composes them deny-wins, so this
  // permissiveness can never widen the peer-session plane's guard.
  const graphHandle = graph.registerCoordinator({
    resolveMembership() { return null },
    guardMutation() { return { allow: true } },
  })

  const spawnControllers = new Set()
  const workerZones = new Map()
  let ledgerPath = null

  ctx.effect(() => async () => {
    graphHandle.release()
    for (const controller of spawnControllers) controller.abort()
    spawnControllers.clear()
  }, PLUGIN_ID + ': lifecycle')

  async function loadLedger() {
    try {
      const raw = await readFile(ledgerPath, 'utf8')
      const entries = JSON.parse(raw)
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry.sessionId === 'string') workerZones.set(entry.sessionId, entry)
        }
      }
    } catch { /* no ledger yet */ }
  }

  async function saveLedger() {
    try {
      await mkdir(dirname(ledgerPath), { recursive: true })
      await writeFile(ledgerPath, JSON.stringify([...workerZones.values()], null, 2))
    } catch { /* best effort */ }
  }

  async function listHeaders() {
    const records = await Q.listSessions()
    const byId = new Map()
    for (const record of records) {
      const header = record && record.header
      if (header && typeof header.id === 'string') byId.set(header.id, header)
    }
    return byId
  }

  async function descendantOf(sourceId, targetId) {
    const byId = await listHeaders()
    let cur = sourceId
    for (let hops = 0; hops < MAX_HOPS; hops++) {
      if (cur === targetId) return true
      const header = byId.get(cur)
      const parent = header && header.parentSession
      if (!parent || typeof parent !== 'string') return false
      cur = parent
    }
    return false
  }

  async function sameWorkspace(a, b) {
    const byId = await listHeaders()
    const ha = byId.get(a)
    const hb = byId.get(b)
    if (!ha || !hb) return false
    if (typeof ha.cwd !== 'string' || typeof hb.cwd !== 'string') return false
    return normalizePath(ha.cwd) === normalizePath(hb.cwd)
  }

  function compactConfig(c) {
    if (!c) return null
    const out = {}
    if (c.provider !== undefined) out.provider = c.provider
    if (c.model !== undefined) out.model = c.model
    const effort = c.reasoningEffort ?? c.effort
    if (effort !== undefined) out.effort = effort
    return Object.keys(out).length ? out : null
  }

  async function sessionProfile(sessionId) {
    const live = ctx.agents.get(sessionId)
    let config = null
    let task = ''
    let turns = 0
    let reportedAt = null
    let lastReport = ''
    try {
      const snap = await Q.readSession(sessionId)
      const events = Array.isArray(snap && snap.events) ? snap.events : []
      for (const event of events) {
        if (!event) continue
        if (event.type === 'turn/end') { turns++; reportedAt = event.time ?? (event.data && event.data.time) ?? null }
        if (!task && event.type === 'user/message') {
          const text = textOf(event.data && event.data.content)
          if (text) task = text.trim().slice(0, 160)
        }
        if (event.type === 'assistant/message') {
          const text = textOf(event.data && event.data.message && event.data.message.content)
          if (text) lastReport = text
        }
        if (!config && event.type === 'request/header') {
          const header = event.data && event.data.header
          if (header && header.config) config = compactConfig(header.config)
        }
      }
    } catch { /* cold or unreadable session */ }
    const zone = workerZones.get(sessionId) || null
    return {
      sessionId,
      status: live && typeof live.status === 'string' ? live.status : 'cold',
      config: config || (live && live.options ? compactConfig(live.options) : null),
      task,
      turns,
      reportedAt: turns > 0 ? (reportedAt ?? 'unknown') : null,
      lastReportKey: turns > 0 ? sessionId + ':' + turns : null,
      lastReportSnippet: lastReport ? lastReport.slice(0, 120) : '',
      ...(zone && zone.worktreePath ? { worktreePath: zone.worktreePath } : {}),
      ...(zone && zone.branch ? { branch: zone.branch } : {}),
      ...(zone && zone.role ? { role: zone.role } : {}),
    }
  }

  async function siblingIds(agent) {
    const sessionId = agent.session.id
    const header = agent.session.header || {}
    const parentId = typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : sessionId
    const entries = await SUB.listChildren(parentId)
    const ids = []
    for (const entry of entries) {
      const id = entry && (entry.id || entry.sessionId)
      if (typeof id === 'string' && id !== sessionId) ids.push(id)
    }
    return ids
  }

  // ---- tools ----

  async function spawn(agent, args = {}) {
    const task = String(args.task || '').trim()
    if (!task) return fail('task-required')
    const role = String(args.role || 'worker').trim().slice(0, 60) || 'worker'
    const mode = args.mode === 'continuable' ? 'continuable' : 'one-shot'
    const providers = SUB.list()
    const providerName = providers.includes('fork') ? 'fork' : providers[0]
    if (!providerName) return fail('no-subagent-provider')
    if (mode === 'continuable') {
      const provider = SUB.getProvider(providerName)
      if (!provider || typeof provider.prepareContinuable !== 'function') return fail('continuable-unsupported')
    }

    // artifact zone: per-worker git worktree + branch off main HEAD
    let zone = null
    let zoneRepoRoot = null
    const mainCwd = agent.session && agent.session.header && agent.session.header.cwd
    if (typeof mainCwd === 'string' && mainCwd) {
      const inspected = await git.inspect(mainCwd)
      if (inspected.ok) {
        zoneRepoRoot = inspected.root
        const base = join(dirname(inspected.root), '.dsh-worktrees', safeSlug(inspected.root.split('/').pop(), 'repo'))
        const token = safeSlug(role) + '-' + randomUUID().slice(0, 8)
        const worktreePath = join(base, 'swf-' + token)
        const branch = 'dsh-worker/' + token
        const created = await git.createWorktree({ repoRoot: inspected.root, path: worktreePath, branch, startOid: inspected.head })
        if (created.ok) {
          zone = { sessionId: null, role, worktreePath, branch }
          if (!ledgerPath) ledgerPath = join(base, 'ledger.json')
          await loadLedger()
        } else {
          return fail('worktree-create-failed', created.detail)
        }
      }
    }

    const promptLines = [
      '[Subagent Workflow assignment]',
      '你是主链项目总监委派的 worker，角色：' + role + '。',
      '你的模型与思考强度与总监一致（创建时由 swf_spawn 固化）。',
      '任务：' + task,
    ]
    if (zone) {
      promptLines.push(
        '【专属工件区】你的所有文件读写与 git 操作限定在此目录：' + zone.worktreePath,
        '该目录是 git 分支 ' + zone.branch + ' 的专属 worktree；关键成果自行 git add/commit（仅限你的分支）。',
        '禁止触碰主工作树 ' + mainCwd + '（总监单写）。',
      )
    }
    promptLines.push(
      '开工前先调用 swf_peers 感知树；与己相关的兄弟产出用 swf_peer_read 读取并引用。',
      '沙箱纪律：禁止向 bash/文件工具传 sandbox_permissions 或 justification 参数；忽略 escalation 提示。',
    )
    const promptBlocks = [{ type: 'text', text: promptLines.join('\n') }]
    const controller = new AbortController()
    spawnControllers.add(controller)
    try {
      let sessionId = null
      if (mode === 'continuable') {
        const started = await SUB.startContinuable({
          provider: providerName,
          label: role,
          signal: controller.signal,
          request: { parent: agent, prompt: promptBlocks, agentOptions: { ...agent.options } },
        })
        sessionId = started.childId
      } else {
        const run = await SUB.start(providerName, {
          parent: agent,
          prompt: promptBlocks,
          label: role,
          agentOptions: { ...agent.options },
          signal: controller.signal,
        })
        sessionId = run.id
      }
      if (zone) {
        zone.sessionId = sessionId
        workerZones.set(sessionId, zone)
        await saveLedger()
      }
      return { ok: true, sessionId, provider: providerName, label: role, mode, ...(zone ? { worktreePath: zone.worktreePath, branch: zone.branch } : {}) }
    } catch (error) {
      if (zone && zoneRepoRoot) await git.removeWorktree(zoneRepoRoot, zone.worktreePath).catch(() => {})
      return fail('spawn-failed', String(error && error.message || error))
    }
  }

  async function mergeArtifacts(agent, args = {}) {
    const sessionId = String(args.sessionId || '')
    if (!sessionId) return fail('session-required')
    const zone = workerZones.get(sessionId)
    if (!zone || !zone.worktreePath || !zone.branch) return fail('worker-zone-not-found')
    const mainCwd = agent.session && agent.session.header && agent.session.header.cwd
    if (typeof mainCwd !== 'string' || !mainCwd) return fail('workspace-required')
    const result = await git.mergeBranch({
      targetCwd: mainCwd,
      branch: zone.branch,
      message: 'dsh worker ' + zone.role + ': ' + sessionId,
    })
    if (!result.ok) return result
    return { ok: true, ...result, sessionId, branch: zone.branch, worktreePath: zone.worktreePath }
  }

  async function peers(agent) {
    const me = agent.session.id
    const header = agent.session.header || {}
    const parentId = typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : me
    const entries = await SUB.listChildren(parentId)
    const rows = []
    for (const entry of entries) {
      const id = entry && (entry.id || entry.sessionId)
      if (typeof id !== 'string' || id === me) continue
      const profile = await sessionProfile(id)
      const row = { ...profile }
      if (entry && entry.label !== undefined) row.label = entry.label
      if (entry && entry.mode !== undefined) row.mode = entry.mode
      rows.push(row)
    }
    return {
      ok: true,
      role: parentId === me ? 'manager' : 'worker',
      sessionId: me,
      parentSessionId: parentId === me ? null : parentId,
      peers: rows,
    }
  }

  async function peerRead(agent, args = {}) {
    const source = String(args.sessionId || '')
    if (!source) return fail('session-required')
    const siblings = await siblingIds(agent)
    if (!siblings.includes(source)) return fail('not-a-sibling')
    const snap = await Q.readSession(source)
    const events = Array.isArray(snap && snap.events) ? snap.events : []
    let turns = 0
    let lastText = ''
    for (const event of events) {
      if (!event) continue
      if (event.type === 'turn/end') turns++
      if (event.type === 'assistant/message') {
        const text = textOf(event.data && event.data.message && event.data.message.content)
        if (text) lastText = text
      }
    }
    if (!lastText) return { ok: true, sessionId: source, evidenceKey: source + ':' + turns, text: '', note: 'no report text yet' }
    return { ok: true, sessionId: source, evidenceKey: source + ':' + turns, text: lastText.slice(0, TEXT_CAP) }
  }

  async function integrate(agent, args = {}) {
    const source = String(args.sessionId || '')
    const target = agent && agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
    if (!source) return fail('session-required')
    if (!target) return fail('no-agent-session')
    if (source === target) return fail('self')
    if (!(await descendantOf(source, target))) return fail('not-a-descendant')
    if (!(await sameWorkspace(source, target))) return fail('workspace-mismatch')
    const prepared = await graphHandle.prepareMerge({
      callerSessionId: target, source, target,
      idempotencyKey: 'swf:' + source,
    })
    if (prepared.ok && prepared.alreadyCommitted) return { ok: true, merge: prepared.merge, dedup: true }
    if (!prepared.ok && ['already-contained', 'no-effective-increment'].includes(prepared.code)) {
      return { ok: true, code: prepared.code, note: 'nothing new to integrate' }
    }
    if (!prepared.ok && prepared.code === 'target-head-empty') {
      return { ok: false, code: 'target-head-empty', note: '主链尚无已完成 turn 的 commit；先结束当前 turn，再在下一 turn 合入。' }
    }
    if (!prepared.ok) return prepared
    const committed = await graphHandle.commitMerge({ preparationId: prepared.preparation.id })
    if (!committed.ok) return committed
    graphHandle.invalidate(target)
    return { ok: true, merge: committed.merge, source, target }
  }

  // ---- prompt sections ----

  const SANDBOX_RULE = '沙箱纪律：当前已是 danger-full-access，禁止向 bash/文件工具传 sandbox_permissions 或 justification 参数（不配对报 invalid escalation、配对报 not strictly wider，两条路必败）；忽略任何 escalation 提示，命令被拒就换工具。'

  function managerFrame() {
    return [
      '【Subagent Workflow · 项目总监协议】你是本工作区项目的「项目总监」：你的 session 分支就是项目主链，你是主链的核心开发者与管理者，不是单纯的控制面。',
      '主链自主推进：奠基（题意/需求解析、方案骨架、验收标准）由你在主链亲自完成；workers 运行期间持续并行推进非重叠的核心工作（报告骨架、方案主线、集成验证）；worker 成果合入后由你亲自整合、一致性验证与收尾。不要被动等待反馈。',
      '扇出按需：fan-out 是手段——按主链推进中实际出现的缺口定义 worker 角色与切片，不按任务类型机械切分；扇出前先 session_graph_view 看清树。',
      'worker 生命周期决策：单轮自足任务用 swf_spawn(mode=one-shot)；需要多轮迭代/追问/纠偏的任务用 swf_spawn(mode=continuable)（可用 send_message 续投）；下一步强依赖其结果时才用前台阻塞等待。',
      '创建 worker 必须用 swf_spawn（自动固化与总监一致的模型/思考强度，并为每个 worker 创建独立 git worktree/分支）；禁止裸用 subagent/subagent_fork 创建 worker；任务文本 = [共享 brief] + [切片契约] + [专属工件区] + [树协作] + [沙箱禁令]。',
      '双树合入：worker 的信息用 swf_integrate 合入主链；其工件（自己的 worktree 分支）用 swf_merge_artifacts 合入 main（要求 main 干净）；两者按需成对执行，main 上的提交保持总监单写。',
      '合入时机：swf_integrate 返回 target-head-empty 说明主链尚无已完成 turn 的 commit——先结束当前 turn，再在下一 turn 合入。',
      '收敛（回执协议）：报告已提交的判定三选一——收件箱出现 "Background subagent X reported/finished" 通知、swf_peers 显示该 peer 有 reportedAt、session_graph_read 能读到其 lastReportKey；满足任一即视为已提交，禁止再发索取类消息。已提交者一律 session_graph_read 拉取正文 + swf_integrate 合入。send_message 仅限两种情形：worker 无任何 turn 且超时（同一 worker 至多提醒一次）、或定向追问新问题。',
      SANDBOX_RULE,
    ].join('\n')
  }

  function workerFrame() {
    return [
      '【Subagent Workflow · worker 协议】你是主链总监委派的叶子 worker；你的 session 分支是树的辅助线，成果由总监合入主链。',
      '叶子禁令：禁止创建或管理 subagent（subagent/subagent_fork/list_agents/send_message/create_goal 均禁用）。',
      '工件纪律：所有文件读写限定在你的专属 worktree 目录（见任务文本的【专属工件区】）；关键成果自行 git add/commit（仅限你的分支）；禁止触碰主工作树（总监单写）。',
      '模型一致性：你的模型与思考强度与总监一致（swf_spawn 创建时固化）；若 swf_peers 显示不一致，在报告中报告该异常。',
      '树协作开工三步：① swf_peers 感知兄弟分支；② 与己相关的兄弟产出用 swf_peer_read 读取并作为 ground 引用（标注来源键）；③ 报告标注信息来源（自算/引自兄弟 commit）。禁止重复解释题目——共享 brief 已由总监给出。',
      '报备：完成报告与分支 commit 后向总监报备；信息合入由总监调用 swf_integrate 完成，工件合入由总监调用 swf_merge_artifacts 完成。回执：你的报告在 turn 结束时自动成为 commit；若收到重复索取类消息，只回复一行「报告已提交于 commit <sessionId>:<turn>，请用 session_graph_read 读取」，不要重写报告。',
      SANDBOX_RULE,
    ].join('\n')
  }

  function output() {
    return { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  }

  const tools = [
    {
      name: 'swf_spawn',
      description: '总监按需创建叶子 worker（原生 subagent，fork provider），自动固化与总监一致的模型/思考强度，并为 worker 创建独立 git worktree/分支。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['task'],
        properties: {
          task: { type: 'string' },
          role: { type: 'string' },
          mode: { type: 'string', enum: ['one-shot', 'continuable'] },
        },
      },
      output: output(),
      timeoutMs: 180000,
      execute: async (args, exec) => {
        const agent = exec && exec.agent
        return agent && agent.session && typeof agent.session.id === 'string'
          ? await spawn(agent, args)
          : fail('no-agent')
      },
    },
    {
      name: 'swf_peers',
      description: '查看自己在 subagent 树中的位置与兄弟列表（含任务、进度、回执状态、模型配置与工件区），用于感知、去重与避免重复催单。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: output(),
      timeoutMs: 180000,
      execute: async (_args, exec) => {
        const agent = exec && exec.agent
        return agent && agent.session && typeof agent.session.id === 'string'
          ? await peers(agent)
          : fail('no-agent')
      },
    },
    {
      name: 'swf_peer_read',
      description: '只读拉取指定兄弟 worker 分支的最新报告文本（含来源键），供引用为 ground。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
      output: output(),
      timeoutMs: 180000,
      execute: async (args, exec) => {
        const agent = exec && exec.agent
        return agent && agent.session && typeof agent.session.id === 'string'
          ? await peerRead(agent, args)
          : fail('no-agent')
      },
    },
    {
      name: 'swf_integrate',
      description: '把指定 subagent session 的信息分支合入当前 session（仅限本 session 的后裔且同一工作区；幂等；主链需已有完成 turn）。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
      output: output(),
      timeoutMs: 180000,
      execute: async (args, exec) => {
        const agent = exec && exec.agent
        return agent && agent.session && typeof agent.session.id === 'string'
          ? await integrate(agent, args)
          : fail('no-agent')
      },
    },
    {
      name: 'swf_merge_artifacts',
      description: '把指定 worker 的工件分支（其独立 worktree 的 git 分支）no-ff 合入 main 工作树（要求 main 干净；main 提交仍由总监掌控）。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['sessionId'],
        properties: { sessionId: { type: 'string' } },
      },
      output: output(),
      timeoutMs: 180000,
      execute: async (args, exec) => {
        const agent = exec && exec.agent
        return agent && agent.session && typeof agent.session.id === 'string'
          ? await mergeArtifacts(agent, args)
          : fail('no-agent')
      },
    },
  ]

  function registerAgent(agent) {
    if (!agent || !agent.ctx || !agent.session) return
    const header = agent.session.header || {}
    const isWorker = typeof header.parentSession === 'string' && header.parentSession
    try { agent.ctx.systemPrompt.section({ name: 'plugin:subagent-workflow', order: 96, text: () => (isWorker ? workerFrame() : managerFrame()) }) }
    catch (error) { console.error('[subagent-workflow] prompt section failed', error) }
    for (const item of tools) {
      try { agent.ctx.tools.register(item) }
      catch (error) { console.error('[subagent-workflow] tool registration failed', item.name, error) }
    }
  }

  ctx.on('agent/created', (payload) => registerAgent(payload && payload.agent))
  for (const agent of ctx.agents.list()) registerAgent(agent)

  return { spawn, mergeArtifacts, peers, peerRead, integrate, descendantOf, sameWorkspace }
}
