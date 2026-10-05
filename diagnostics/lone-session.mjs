/**
 * 探针：一个**完全没有分叉**的普通会话，这个插件到底给了什么？
 * 不依赖任何 subagent / workflow。跑完即删。
 */
import { apply } from '../lib/index.js'

const handlers = new Map()
const stores = new Map()
const sections = []
const tools = []

const SID = 'session-lone-1'
const CWD = 'C:/probe/repo'

// 单会话日志：3 个完成的 turn，没有任何子会话
const events = []
for (let turn = 0; turn < 3; turn++) {
  const base = turn * 4
  events.push(
    { type: 'turn/start', seq: base, time: 100 + base, data: { turn } },
    { type: 'user/message', seq: base + 1, time: 101 + base, data: { id: 'u' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第' + turn + '轮：请做第' + turn + '件事，这段文本足够长以便被截断测试' }] } },
    { type: 'assistant/message', seq: base + 2, time: 102 + base, data: { turn, step: 0, stream: [], message: { id: 'a' + turn, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock-1' }, content: [{ type: 'text', text: 'done ' + turn }] } } },
    { type: 'turn/end', seq: base + 3, time: 103 + base, data: { turn, reason: 'completed' } },
  )
}

const header = { id: SID, cwd: CWD, createdAt: 1 }
const ctx = {
  config: {},
  get: () => undefined,
  on: (n, fn) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(fn); return () => {} },
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
  provide: () => () => {},
  webServer: { register: () => () => {} },
  sessionQuery: {
    listSessions: async () => [{ header }],
    readSession: async (id) => (id === SID ? { events } : { events: [] }),
    readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: '我的一次普通会话' } } })),
  },
  workspaceRegistry: {
    list: () => [{ id: 'w1', path: CWD, title: 'repo', sessionIds: [SID] }],
    resolveByPath: async () => ({ id: 'w1', path: CWD, title: 'repo', sessionIds: [SID] }),
  },
  storageDomain: {
    open: async (spec) => {
      const tables = {}
      return {
        table: (name) => {
          const k = spec.name + '.' + name
          if (!stores.has(k)) stores.set(k, new Map())
          const d = stores.get(k)
          tables[name] = {
            get: (x) => d.get(x), entries: () => d.entries(), keys: () => d.keys(), size: d.size,
            put: async (x, v) => { d.set(x, structuredClone(v)) }, delete: async (x) => d.delete(x),
            update: async (x, fn) => { const n2 = fn(d.get(x)); d.set(x, n2); return n2 },
          }
          return tables[name]
        },
        close: async () => {},
      }
    },
  },
  agents: { list: () => [], get: () => null, roots: () => [] },
  sessions: { get: () => null },
  subagents: { listChildren: async () => [], list: () => [], getProvider: () => null },
  subprocess: { spawn: () => { throw new Error('unused') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
  llm: {},
}

const api = apply(ctx, {})

// 模拟宿主为一个普通会话挂载 agent 表面
const agentCtx = {
  ...ctx,
  tools: { register: (t) => { tools.push(t); return () => {} } },
  systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
}
for (const fn of handlers.get('agent/created') || []) await fn({ agent: { id: SID, session: { id: SID, header }, options: {}, ctx: agentCtx } })
await new Promise((r) => setTimeout(r, 20))

const g = await api.graph.loadProject(SID)
const commits = [...(g.commitByKey ? g.commitByKey.values() : [])]

console.log('=== 单会话、零分叉时插件给了什么 ===')
console.log('')
console.log('1) 注入进系统提示词的文本：')
const sec = sections.find((s) => s.name === 'plugin:session-graph')
console.log(sec ? '   ' + JSON.stringify(typeof sec.text === 'function' ? sec.text() : sec.text) : '   （无！）')
console.log('')
console.log('2) 注册给模型的工具：')
const graphTools = tools.filter((t) => t.name.startsWith('session_graph_')).map((t) => t.name)
const wfTools = tools.filter((t) => t.name.startsWith('workflow_')).map((t) => t.name)
const swfTools = tools.filter((t) => t.name.startsWith('swf_')).map((t) => t.name)
console.log('   图谱平面 (' + graphTools.length + '): ' + graphTools.join(', '))
console.log('   同伴工作流 (' + wfTools.length + '): ' + wfTools.join(', '))
console.log('   子代理工作流 (' + swfTools.length + '): ' + swfTools.join(', '))
console.log('')
console.log('3) 图谱数据：')
console.log('   branches =', g.branches.length)
console.log('   commits  =', commits.length)
console.log('   merges   =', (g.projectMerges || []).length)
console.log('')
console.log('4) 每个 commit 能读出什么（这是信息保存的核心）：')
for (const c of commits.slice(0, 3)) {
  console.log('   ' + c.key + '  turn=' + c.turn + '  seq=' + c.userSeq + '-' + c.endSeq)
  console.log('      firstUser: ' + JSON.stringify(String(c.firstUser || '').slice(0, 50)))
  console.log('      ass      : ' + JSON.stringify(String(c.ass || '').slice(0, 30)))
  console.log('      human    : ' + c.human)
}
console.log('')
console.log('5) 信息 DAG（跨分支的命题/合入图）：')
console.log('   dag 存在:', !!g.dag)
if (g.dag) {
  console.log('   nodes:', (g.dag.nodes || []).length, ' edges:', (g.dag.edges || []).length)
  console.log('   propositions:', (g.dag.propositions || []).length)
}
console.log('')
console.log('6) 落盘（storage domain 表）：')
for (const [k, v] of stores) console.log('   ' + k + ' -> ' + v.size + ' 行')
