# dsh-graph-workflow

**三个插件合并为一个可安装插件** —— 把 `dsh-session-graph`、`dsh-agent-workflow`、`dsh-subagent-workflow` 的全部源码与功能重新继承进一个包，保留这里的 GUI 和它的所有功能。

原文仓库：

| 原插件 | 内容 | 合并后位置 |
|---|---|---|
| [dsh-session-graph](https://github.com/MadTONY061128/dsh-session-graph) | 会话信息 DAG、合入管线、Git 图谱侧栏 | `lib/graph.js` + `lib/dag-core.js` |
| [dsh-agent-workflow](https://github.com/MadTONY061128/dsh-agent-workflow) | 对等会话工作流协议、WAL 事务、租约管理器 | `lib/workflow.js` + `lib/workflow-core.js` |
| [dsh-subagent-workflow](https://github.com/MadTONY061128/dsh-subagent-workflow) | 同会话子代理工作流、worktree 工件区、台账 | `lib/subagent-flow.js` |

没有裁剪：包括作者已声明退休（`ARCHIVED.md`）的对等会话工作流协议，也完整保留。

---

## 为什么可以这样自由地改

DSH 的 profile 是**有序的 bundle 补丁层**，不是"内核 + 插件"：

- 没有特权内核，所有能力（工具、提示词段、HTTP 路由、存储、服务）都由插件通过 `ctx` 提供；
- 某个插件是否激活由**它 inject 的服务是否可用**决定，不由加载顺序决定；
- 补丁按 `id` 合并，同一行**后来者覆盖**。

所以"合并三个插件"不需要改 DSH，只需要让新包成为**一行**、并提供三方合并后所需的服务集合。

---

## 合并中与实机验证中解决的五个真实问题

### 1. `sessionGraph` 只能注册一次（致命）

`dsh-session-graph` 的协调器缝隙原本写成：

```js
if (coordinator) throw new Error('sessionGraph coordinator already registered')
```

而 `dsh-agent-workflow` 和 `dsh-subagent-workflow` **都**在启动时调用 `registerCoordinator`。三个插件并排挂载时第二个必崩 —— 这也正是它们从来无法独立安装的原因（`dsh-subagent-workflow` 硬依赖 `sessionGraph`）。

改法：缝隙改为**累积策略**，每个调用者仍拿到自己的 capability handle，而成员解析与变更裁决在多个策略间合成：

- `guardMutation` —— **deny-wins**（拒绝优先）：逐个咨询，第一个拒绝即为终局。宽松的平面永远无法放宽严格平面的限制，结果与顺序无关。
- `resolveMembership` —— **first-non-null wins**（首个非空生效）：`subagent-flow` 平面返回 `null` 表示"不替换工作区闭包"，于是回落到 `graph` 平面的闭包逻辑。

```js
const coordinatorPolicies = []   // 原为 let coordinator = null
```

### 2. `setup` 返回值崩溃（就是退休原因）

`dsh-agent-workflow` 的 `ARCHIVED.md` 记的崩溃是 `(intermediate value)?.commit is not a function`。根因在 `dsh-agent-loop/lib/index.js:1874`：

```js
(await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id))?.commit()
```

可选链**只**挡 `null`/`undefined`。而 `dsh-agent-preset-registry` 声明 `composeFrom(ctx, parent): string | undefined` —— 返回的是**预设 id 字符串**（truthy）。`"str".commit` 是 `undefined` → TypeError，与归档记录逐字吻合。

改法：`setup` 改为语句体、不返回值（`mount` 的 `AgentPreset` 对象同样会被送进 `.commit()`，一并修掉）。两处：`lib/workflow.js` 的 `resume` 与 `create`。

### 3. 自我注入会永久挂起

合并后本包**提供** `sessionGraph`，因此不能同时 `inject` 它 —— Cordis 会等一个自己提供的服务，插件永久 park。改法：`inject` 里过滤掉 `sessionGraph`，由入口把服务**直接传给**两个编排平面。

```js
export const inject = [...new Set([...graphInject, ...workflowInject, ...subagentFlowInject])]
  .filter((service) => service !== 'sessionGraph')
```

### 4. 装进**正在运行**的宿主时，图谱平面没有补装（实机发现）

这是把插件装进真实 profile 之后、由**本次会话自己**暴露出来的：安装完成后
`swf_*`（子代理平面）与 `workflow_*`（同伴工作流平面）的工具都出现在工具表里，
唯独 `session_graph_*` 四个工具**一个都没有**。没有任何报错 —— 就是少了。

原因是三个平面的补装方式不一致：

| 平面 | `agent/created` 订阅 | 挂载时补扫 `ctx.agents.list()` |
|---|---|---|
| workflow | ✅ | ✅ |
| subagent-flow | ✅ | ✅ |
| **graph** | ✅ | ❌（缺） |

插件是**装进一个已经在跑的宿主**的，而当前会话在挂载之前就存在 —— 它永远不会再触发
`agent/created`。于是只订阅、不补扫的平面，恰好对「正在安装它的那个会话」失效。
本机时间线正好是这个情形：

```
会话 b85d8e94 创建于   2026-09-17
插件安装于             2026-10-03
```

补法就是补上另外两个平面早就有的那一行：

```js
for (const agent of ctx.agents.list()) registerAgentSurface(agent)
```

回归测试两处：`provenance-integration.test.js` 里构造一个**在 `apply()` 之前就存在**
的 agent（只建实例、不触发 `agent/created`），断言四个图谱工具仍被注册；
`plugin-structure.mjs` 增加一条源码级检查，断言三个平面都含补扫语句
（失败是「漏了一次调用」，不是「返回值不对」，所以只能查源码）。
两处都实测过：去掉补扫即失败，加回即通过。

**对使用者的直接影响**：如果插件是装进一个**已经在跑**的宿主，那么在下一次重启宿主
之前，**当前这个会话拿不到 `session_graph_*` 四个工具**（其余两个平面因为它们本来就
补扫，会立刻生效）。这不是「功能缺失」，是不重启就补不上；重启后即恢复。
本机正好落在这个窗口里：3080 的 GUI 进程起于 `10-01 22:33`，插件装于 `10-03 23:40`。

> 重复注册安全性：`agent.ctx.tools.register()` 最终走 `layer.tools.insert(name, …)`，
> 按名字覆盖而非抛错。所以「补扫 + `agent/created` 各注册一次」是幂等的 ——
> 另外两个平面本来就是这个行为，图谱平面补齐后三者一致。已用真实 host 实测过 40 次
> 注册落到 20 个名字（每个 2 次），工具表无重复项。

### 5. 工作区解析的未设防回退（同一轮排查中发现）

顺手发现 `loadProject` 里那处回退还留着早期写法：

```js
if (!ws) ws = await W.resolveByPath(cwd).catch(() => null)   // 旧
if (!ws) { try { ws = await W.resolveByPath(cwd) } catch (e) { ws = null } }   // 新
```

`W.resolveByPath(cwd).catch(...)` 假设它**一定返回 Promise**。若某个 shim 同步抛错
（或实现改为不返回 Promise），炸的就是 `.catch` 本身 —— 同样表现为「图谱工具静默消失」，
与第 4 条症状**一模一样**，所以两处必须用同一种写法。已统一，并加了
「注册表同步抛错仍必须给出工具」的回归测试。

---

## 新增：结构化溯源链（命题 → 提交 key → 原文位置）

原实现对命题依据的保存是**自由文本 + 位置索引**：

```js
ground: { kind: 'observed', evidence: '【2】' }
```

`【2】` 只在这批输入的数组里有意义，三重脆弱：位置偏移即失义；渲染时用 `/(\d+)/` 正则重解析，任何无关数字都可能被匹配；模型可以编造越界编号而**无人发现**。

`lib/provenance-core.js` 把它编译成结构化、可存储、可反向查询的链：

```
proposition.claim
  └─ ground.provenance
       ├─ commitKey  'session-abc:3'      ← DAG 中的稳定身份
       ├─ sessionId / turn
       ├─ locator    { userSeq, endSeq }  ← 原文在会话日志中的精确事件区间
       ├─ time / userTime / quote
       └─ resolution 'exact' | 'derived' | 'unresolved'
```

解析是**确定性且全覆盖**的：

| 情形 | 结果 |
|---|---|
| 引用编号有效 | `exact`，指向被引用的提交 |
| 证据里直接写了 commit key | `exact` —— 按构造就是识别而非猜测（见下） |
| 编号越界/编造 | `derived`，按命题自身位置回退，并**记录**该引用不可用 |
| 未给引用 | `derived`，`cited: null`（与"引用错误"可区分） |
| 完全无可用条目 | 返回 `null`，**绝不编造**链条 |

### 一处自己踩到的降级：把「识别」当成了「猜测」

无 LLM 的确定性回退路径每条命题都会填上自己那条提交的 key：

```js
propositions: diffCommits.map((c) => ({ claim: …, ground: { kind: 'inferred', evidence: c.key } }))
```

但 `citedIndex()` 只认抽取提示词要求的 `【n】` 标记，于是这些**已经写明提交身份**的
命题全部落进位置回退，渲染出来是 `0/1 直接可定位，1 位置回退` —— 一条本来完全确定
的链被自己说成是猜的。实测发生在把 worker 报告并入主链时的自动摘要里。

修法是让解析器先认编号、再认 key（`keyIndexIn()`），且只认同表内已存在的 key：

- 只匹配**表里已有的** entry，不会凭空造出一条链；
- `s:1` 不能被 `s:12` 里的前缀命中（后面跟数字即判不匹配），重叠时取最长者；
- `【n】` 仍然优先 —— 模型明确写的标记比正文里恰好出现的字符串更权威。

同一个例子现在读作 `1/1 直接可定位，0 位置回退，ratio=1`。

配套：

- `ground.evidence` **原样保留**，旧数据与旧读者不受影响；`provenance` 纯属新增字段。
- `sourceIndex` 记录本次抽取的完整输入清单，读方可从任一命题跳到全量输入。
- 注入的合入条目会显式声明链完整度（`溯源链：3/5 条命题的引用可直接定位到提交；2 条为位置回退`），把"弱引用"暴露给读它的模型，而不是让所有命题看起来同样有据。
- `session_graph_read "session-…:turn"` 现在返回 `locator` 与 `usedBy`（哪些合入结论依据了这个提交）。
- 新工具 `session_graph_trace`：`mg:…` 按命题列出各自提交链与原文位置并列出 `weak`（引用失效）条目；`session-…:turn` 列出所有依据它的合入命题。

配置项 `provenance: false` 可关闭（退回旧行为，存储格式不变）。

---

## 安装

```bash
dsh plugin --profile web add link:/path/to/dsh-graph-workflow dsh-better-sidebar@0.22.1
```

`dsh-better-sidebar` 是 GUI 的宿主（侧栏 tab 服务）。**版本必须匹配本地 DSH**：

| better-sidebar | peer 要求 | 与 DSH `0.1.7-rc.2` |
|---|---|---|
| `0.24.1` | `^0.2.0-rc.1` | ✗ 不兼容 |
| **`0.22.1`** | `^0.1.7-rc.1` | ✓ 可用 |

`0.22.1` 的客户端代码**零改动**即可用：`registerTab(descriptor)` 的 `{id,title,single,order,component}` 与 `TabComponentProps` 的 `{ctx,store,scope.sessionId}` 在 `0.22.1` 与 `0.24.1` 之间逐字节相同。它自带 `cordis.patch.yml` 挂载 `better-sidebar` 行（含重复挂载防护），**不要再手工挂一次**。

## 配置（`cordis.patch.yml`）

```yaml
enableGraph: true        # 关掉它则依赖其协调器缝隙的编排平面也不挂载
injectMerges: true       # false：保留合入管线与 GUI，但不写入任何会话提示词
frameMaxChars: 4000      # 常驻提示词的合入条目预算
cacheTtlMs: 120000
autoSummary: false       # 打开后会把轮次摘要与合入增量发给模型服务商
provenance: true         # 结构化溯源链
enableWorkflow: true     # 对等会话工作流协议
defaultLeaseMs: 300000
enableSubagentFlow: true # 同会话子代理工作流
```

## 构成

```
lib/
  index.js            入口：一行插件，按序装配三个平面
  graph.js            信息图谱平面（提供 sessionGraph，持有 /sgx 路由与图谱工具）
  workflow.js         对等会话工作流平面（workflow_* 工具）
  subagent-flow.js    同会话子代理平面（swf_* 工具）
  dag-core.js         纯 DAG 核心（零依赖，最易移植的资产）
  workflow-core.js    纯协议核心（状态机、封装校验、授权）
  provenance-core.js  结构化溯源链（纯函数）
  git-runtime.js      两套 git 运行时的并集（两个平面共用一个）
client-src.js         GUI 源（两个客户端合并为一个 apply）
client.js / dist/     ModuleLoader 包装产物（node build.mjs）
```

路由：`/sgx/*`（信息图谱）+ `/awf/*`（工作流状态），均为 loopback 限定。
服务：`sessionGraph`（名称沿用，兼容生态）。

## 验证

```bash
npm test             # build + 全部行为测试
npm run test:structure
npm run test:host    # 用真实 @deepseek-ai/dsh-session 驱动，需在 dsh 安装树内可解析
```

77 项行为测试 + 21 项结构自检全绿：

- **DAG 语义**（5）：祖先闭包、增量 `Δ_{A→B}`、merge-base / criss-cross、revert 取消注入而不删祖先、传递合入去重。
- **溯源链**（26）：最后冒号切分、引用解析、越界降级、绝不复述、不改动输入、JSON 往返、健康度、反查、定位区间校验；以及「证据里直接写了 commit key」这条路径 —— 它按构造就是精确的，必须判为 `exact` 而不是退化成位置猜测（含 `s:1` 不能命中 `s:12` 的边界处理）。
- **溯源集成**（13）：驱动**真实插件**跑一次合入再反查，断言 `exact/ratio` 随引用方式变化；并覆盖「挂载前已存在的 agent 仍拿到图谱工具」与「工作区注册表同步抛错仍给出工具」两条实机踩到的回归。
- **Fork 血缘**（4）：子会话日志里属于祖先 seed 前缀的提交必须归还祖先，不能被算作子会话自己的工作量；旧字段不覆盖新字段；无继承前缀时退化为「全部算自己」。
- **客户端布局**（8）：合入/revert 行序、车道、肘形连接、空分支 tip、120s 刷新。
- **客户端产物**（9）：加载真实 `client.js` 包并驱动 `apply` —— 断言**两个 tab 都注册**（`dsh-session-graph` + `dsh-agent-workflow`）、二者的 `registerTab` 描述符合法、两份样式表各自注入与卸载、header 入口走官方 slot、注册阶段不发网络请求。
- **宿主集成**（4）+ **成员闭包**（5）：合入/注入/撤销、并发合并串行化与去重、受信协调器跨 worktree、无完成轮次的目标分支拒绝、跨工作区隔离、子代理成员闭包。
- **同伴工作流成功路径**（3）：唯一一条**真的建起 workflow** 的测试 —— 在一个**真实 git 仓库**（临时目录，真跑 `git`）里创建 workflow、分叉 worker、断言 worktree/分支真的存在，并就地断言 fork 血缘契约写的是 `meta.isSeeded + 顶层 inheritedEventCount`（旧写法会让这条测试失败）。另覆盖 dirty 工作树拒绝与非 manager 越权。
- **结构自检**（21）：`plugin-structure.mjs` 用 mock 宿主真实调用 `apply()` —— 断言服务提供、两个编排平面与图谱平面并存、**两次 `registerCoordinator` 共存**（上游第二次必抛）、`release()` 只撤回自己的策略、`inject` 无重复且排除自提供服务、两个存储域各自开启、工具/提示词段形状合法、禁用某平面不影响其他、某平面抛错不拖垮图谱、worker 创建使用当前血缘契约、三个平面都有挂载时补扫。
- **真实宿主契约**（`test/verify-fork-contract.mjs`，15 项）：用**真实的** `@deepseek-ai/dsh-session` + cordis `Context` 驱动 `SessionStore`，逐一比对新旧两种创建参数的落盘结果（见下节）。

### 真实宿主端到端验证（已实测）

在本地 profile 上以 `--port 0` 起了**两轮**一次性实例（不影响运行中的 3080 GUI）；第二轮是 fork 血缘修复之后重跑的：

```
dsh web: http://127.0.0.1:53042/?token=…
```
- 启动**零错误零警告**（stdout/stderr 均无内容）—— 无协调器冲突、无存储域失败。
- `GET /sgx/graph?session=probe` → `200 {"error":"session-not-found"}`（路由已挂载，正确响应不存在的会话）。
- `GET /awf/state?session=probe` → `200 {"ok":false,"code":"not-in-workflow"}`（工作流平面亦已挂载）。
- 客户端预加载组 `plugins/??…dsh-graph-workflow/client.js…` → `200`，**10,360,334 字节**的组内容中同时含 `dsh-graph-workflow`、`dsh-session-graph`、`dsh-agent-workflow`、`data-sgx`、`data-awf`、`registerTab` —— 两个 GUI tab 都进了浏览器。
- 自检：`client.js` 与 `dist/client.js` 字节一致（64,269 B），`node --check` 通过，7 个必需标记齐全。

> 探测提示：首轮曾误报 `401 Unauthorized`。原因是抓 URL 的正则
> `http://127\.0\.0\.1:\d+` 把 `?token=…` 截掉了，于是拿空 token 去请求。
> 改为先取整行再切分、并用 `-SessionVariable` 保持会话即得 `200`。
> 路由本身一直是好的 —— 这是探测脚本的错，不是插件的错。

### 继承时修掉的一个静默缺陷：fork 血缘字段改名

DSH 把 fork 血缘从 `SessionHeader.seedLength` 迁移到了
`meta.isSeeded` + 顶层 `inheritedEventCount`。三个上游插件都还在用旧字段，
而这是一处**完全静默**的错误：

| 传入 | 落盘结果 |
|---|---|
| `meta: { isSeeded: true }` + `inheritedEventCount: seed.length` | `header.isSeeded === true`，`inheritedEventCount === 8`，`isOwnSeq(0) === false`（前缀归祖先）✅ |
| `meta: { seedLength: seed.length }` | `header.isSeeded === false`，`inheritedEventCount === 0`，`isOwnSeq(0) === true`（前缀被误判为自己）❌ |

不会抛错，只会让 fork 边界判定整体退化。`test/verify-fork-contract.mjs` 用真实
`SessionStore` 把两种形状都跑了一遍，上面两行就是它的实测输出。

修复点：

- `lib/graph.js` — 新增 `inheritedOf(snap, events)`，优先读日志观测上的
  `inheritedEventCount`，兼容旧 header 的 `seedLength`，并在 `isSeeded` 为真时
  回退到扫描 `session/end-seed {inherited:true}` 标记。原先同步读 header 的
  4 个投影点改为在读取各自日志时就地填充。
- `lib/workflow.js` — worker 创建改为 `meta.isSeeded: true` +
  `inheritedEventCount: seed.length`（这正是宿主自己 fork 会话时的写法，见
  `dsh-api-session-controller/lib/index.js` 的 `agents.create` 调用）。

`test/fork-lineage.test.js` 的测试用例在旧实现下 4 个里有 3 个失败，在新实现下
全绿 —— 这是「测试真的能挡住回归」的证据，而不是事后补的断言。

> 顺带纠正一条容易误判的结论：上游 `dsh-agent-workflow` 的
> `(intermediate value)?.commit is not a function` 崩溃**不是**竞态，而是
> `setup` 箭头函数把 `composeFrom()` 的返回值（一个 preset id **字符串**）
> 当成了 `AgentSetupCommit` —— 可选链只挡 `null`/`undefined`，挡不住真值字符串。
> 已实测复现，修复方式是让 `setup` 用块体、不返回值。

## 保留的已知限制

- 子代理 worktree 隔离是**约定**强制（写在任务文本里），不是机制强制 —— 上游在 `SubagentStartRequest` 缺少 per-child `cwd`/`workspace` 覆盖。
- `subagent` 工具没有可选的 provider/model 参数。
- `dsh-agent-workflow` 原来的每 worker 独立工作区与信息层的工作区约束确实存在设计张力；合并后两个平面共用 `git-runtime.js` 与同一套 worktree 布局，这条张力仍需使用约定处理。

## 许可

MIT。三个原插件均为 MIT；本包为其派生合并。
