/**
 * 探针：日常场景 —— 若干个**互不相干**的普通会话（没有 subagent、没有 fork）。
 * 这才是用户"正常使用"的样子。跑完即删。
 */
import { apply } from '../lib/index.js'

const handlers = new Map()
const stores = new Map()
const sections = []
const tools = []
const CWD = 'C:/probe/repo'

function session(id, title, turns) {
  const events = []
  for (let t = 0; t < turns; t++) {
    const b = t * 4
    events.push(
      { type: 'turn/start', seq: b, time: 1000 + b, data: { turn: t } },
      { type: 'user/message', seq: b + 1, time: 1001 + b, data: { id: 'u' + t, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: title + ' 第' + t + '轮：改一下登录页的样式' }] } },
      { type: 'assistant/message', seq: b + 2, time: 1002 + b, data: { turn: t, step: 0, stream: [], message: { id: 'a' + t, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'm' }, content: [{ type: 'text', text: '改好了 ' + t }] } } },
      { type: 'turn/end', seq: b + 3, time: 1003 + b, data: { turn: t, reason: 'completed' } },
    )
  }
  return { header: { id, cwd: CWD, createdAt: 1 }, events }
}

// 三个平级会话，就像用户平时开的三次对话
const S = [
  session('s1', '修登录页', 2),
  session('s2', '加导出功能', 3),
  session('s3', '排查内存泄漏', 1),
]
const byId = new Map(S.map((s) => [s.header.id, s]))

const ctx = {
  config: {}, get: () => undefined,
  on: (n, fn) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(fn); return () => {} },
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
  provide: () => () => {},
  webServer: { register: () => () => {} },
  sessionQuery: {
    listSessions: async () => S.map((s) => ({ header: s.header })),
    readSession: async (id) => byId.get(id) || { events: [] },
    readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: (byId.get(sessionId) || { header: {} }).header.id } } })),
  },
  workspaceRegistry: {
    list: () => [{ id: 'w1', path: CWD, title: 'repo', sessionIds: S.map((s) => s.header.id) }],
    resolveByPath: async () => ({ id: 'w1', path: CWD, title: 'repo', sessionIds: S.map((s) => s.header.id) }),
  },
  storageDomain: {
    open: async (spec) => ({
      table: (name) => {
        const k = spec.name + '.' + name
        if (!stores.has(k)) stores.set(k, new Map())
        const d = stores.get(k)
        return {
          get: (x) => d.get(x), entries: () => d.entries(), keys: () => d.keys(), size: d.size,
          put: async (x, v) => { d.set(x, structuredClone(v)) }, delete: async (x) => d.delete(x),
          update: async (x, fn) => { const n = fn(d.get(x)); d.set(x, n); return n },
        }
      },
      close: async () => {},
    }),
  },
  agents: { list: () => [], get: () => null, roots: () => [] },
  sessions: { get: () => null },
  subagents: { listChildren: async () => [], list: () => [], getProvider: () => null },
  subprocess: { spawn: () => { throw new Error('unused') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
  llm: {},
}

const api = apply(ctx, {})

// 把"当前会话"设为 s1，模拟用户正坐在第一个会话里
const agentCtx = {
  ...ctx,
  tools: { register: (t) => { tools.push(t); return () => {} } },
  systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
}
for (const fn of handlers.get('agent/created') || []) {
  await fn({ agent: { id: 's1', session: { id: 's1', header: byId.get('s1').header }, options: {}, ctx: agentCtx } })
}
await new Promise((r) => setTimeout(r, 30))

const g = await api.graph.loadProject('s1')

console.log('=== 日常场景：三个互不相干的会话，没有 subagent ===')
console.log('')
console.log('A) 侧栏会画出什么：')
console.log('   分支（每个会话一条）=', g.branches.length)
for (const b of g.branches) console.log('      · ' + b.id + '  commits=' + b.commitCount + '  parent=' + (b.parentId || '无'))
console.log('   提交（每个完成的 turn 一个）=', (g.commitByKey ? g.commitByKey.size : 0))
console.log('   合入 =', (g.projectMerges || []).length)
console.log('')
console.log('B) 当前会话注入到系统提示词的那段：')
const sec = sections.find((s) => s.name === 'plugin:session-graph')
const txt = sec ? (typeof sec.text === 'function' ? sec.text() : sec.text) : '（无）'
console.log(txt.split('\n').map((l) => '   ' + l).join('\n'))
console.log('')
console.log('C) 模型能读别的会话吗（跨会话回忆）：')
const read = tools.find((t) => t.name === 'session_graph_read')
const out = await read.execute({ target: 's2:1' }, { agent: { id: 's1', session: { id: 's1', header: byId.get('s1').header } } })
console.log('   读 s2 的第 2 个 turn ->')
console.log(JSON.stringify(out).slice(0, 500).split('\n').map((l) => '   ' + l).join('\n'))
console.log('')
console.log('D) 关键：模型在普通会话里**能否发现**别的会话存在？')
const view = tools.find((t) => t.name === 'session_graph_view')
const vout = await view.execute({}, { agent: { id: 's1', session: { id: 's1', header: byId.get('s1').header } } })
const vtxt = typeof vout === 'string' ? vout : JSON.stringify(vout)
console.log('   session_graph_view 无参数 -> ')
console.log('   ' + vtxt.slice(0, 400).split('\n').join('\n   '))
console.log('')
console.log('   → 提示词里提到的分支名:', /『([^』]*)』/.exec(txt) ? /『([^』]*)』/.exec(txt)[1] : '(无)')
console.log('   → 提示词里有没有提到 s2 / s3:', /s2|s3/.test(txt))
