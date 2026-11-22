# Portalk P3（durable 层）施工前研判报告 —— pregrill 原料

- 研判人：p2b-g4-pregrill-worker pianist-1（worker pianist）
- 日期：2026-11-22
- 研判对象：`Portalk-蓝图-P3-durable层.md` v0.1 骨架之施工清单 D1-D6（本报告不施工，只作 grill 原料）
- 实况基准：仓 HEAD=61196d4（P2A 收账，78/78 绿）+ **P2B 三件在飞未收账**（工作区实见：`src/heartbeat.mjs`+`test/heartbeat.test.mjs`（G1 心跳树）、`src/acp-adapter.mjs` 的 memoryReminder/forward 增量+`members/schema.json` prefs 枝（G2 记忆提醒）、`src/ep-connector.mjs`+`test/ep-connector.test.mjs`（G3 epForward 接线）——均未 commit）。依赖研判以「HEAD+在飞件接口」为准，评审抽查请注意这个双态。
- 方法：六条 D 逐条对照仓内实码（src/ 九件+members/+test/）与 pi runtime 文档（仓外参照，`/root/portalk-runtime/…/pi-coding-agent/docs/`）；蓝图说法与实码不符处直接点名。

---

## 总述

### 施工顺序建议：D6 → D1 → D2 → D3 → D4 → D5

- **D6 先行**：三件套里唯一不依赖 D1-D5 任何一件的——事件源（pianist 遥测管道）与写通道（壳桥 spoor_*）都已存在，纯 runtime 侧活，可与 P2B 收账并行；且蓝图明说「pianist 审批卡改造与 D6 埋点同批」，先行可为 D5 的读取适配层留好挂点，还能早攒两壳对账数据。
- **D1 次之**：契约面是 D2-D4 的公共地基——没有「契约注册正本+调用发布通道」，挂起无对象、校验无 schema、审批无标的。D1 又几乎全骑现成件（extension 注册机制、system 消息面、WS 广播面），是六条里改动面最小、设计决定却最深的一条（正本形状、宿主归属、拓扑）。
- **D2→D3 是机制主干，顺序不可倒**：D3（回传校验）嵌在 D2 的恢复路径上（「校验不过不恢复」），没有挂起恢复就没有校验的插针位。
- **D4 在机制之后上闸**：通道先通、再上审批闸——但见下文「裸奔窗口」，D2/D3 落地与 D4 之间必须默认拒。
- **D5 殿后**：最厚的产品面（契约文件+编辑回路+LLM 现读现裁+跨 runtime 适配层），吃 D4 的闸、D6 的同批改造、硬闸清单（还在桌面未进仓），且大量决策是甜心级产品决定不是工程决定，适合机制稳定后再动。

### 最危险：D2（挂起/恢复），三条理由

1. **前提失真（最重要单点发现）**：蓝图四个决策里两处写「借 pianist checkpoint，不占资源」「借 pianist checkpoint 机制，等待合法化」。核对 pi runtime 实况：**pi 没有 Temporal 式 workflow 挂起/checkpoint 机制**——文档里「checkpoint」只出现在两处语义：git checkpointing（扩展用例，文件状态快照）与 compaction 的 retainedTail（上下文重建检查点），都不是「挂起等外部事件再恢复」。pi 真正可借的是**会话文件续接**（`--session-id` 续同一 jsonl，acp-adapter 每轮 spawn 已经在用）+ **进程退场**（`pi -p` argv spawn 一轮一进程，stdin EOF 坑账先例）。「挂起粒度」（轮边界 vs 工具调用级）蓝图完全没定义，这一拍板改变 D2 全部形状，是 grill 第一问。
2. **durable 语义全仓无先例**：现仓所有运行态都是内存态——`server.mjs` 的 `pinStates`（内存 Map）、`acp-adapter.mjs` 的 `openSessions`（内存 Set）、`ep-connector.mjs` 的 `sessions`（内存 Map），重启全丢；唯一的持久件是 SQLite（threads/messages）。「挂起≥1小时状态无损」（验收判据 4）若按跨重启口径验收，D2 是全仓第一个真持久状态件，且要横跨三方一致（pi 会话文件 / portalk SQLite / 前端连接），没有先例可抄。
3. **连坐面最大**：编排蓝图（筹备中）明文声明「坐 P3 D1-D3 当投递底座」——跨壳任务书=长命挂起调用（两态回执送达/取件、暂存 3 天、24h 无人取上报）。D2 的 pending 表形状错了，编排面跟着返工。

### 三个横切发现（不属于单条 D，grill 时要整体过）

- **跨机拓扑未排期，验收判据却吃它**：P3 验收判据 1 是「琴师在云端……云端无 shell 权限」。但现况 `server.mjs` 缺省 `host='127.0.0.1'`（注释原话「桌面单机面，不出网」），媒人/中转层（消息中转 v0.1）与 connector 出站形态都未施工。P3 若按单机桌面形状先落（agent 与前端同用户域），判据 1 的「跨机」半边其实是中转层的活——**P3 的验收口径要先改写或拆期**，否则按现判据验收必然红。
- **P0 定案与 P3 需求有一道接缝**：P0 §5a 定案「manifest 不存 caps——Portalk 不替 runtime 声明工具」（`members/pianist.yaml` 无 caps 字段，注释明示）。而 D1 的契约正本必须有人存（回传校验 D3、审批 D4 都要读它）。这不冲突——callback 契约不是 runtime 工具清单的复述，是 agent 的**声明式委托**——但「契约正本归 Portalk」与「Portalk 不替 runtime 声明工具」的边界要在 grill 里说清，防止两套声明面双写（P0 已为同样的理由删过 caps 字段一次）。
- **P2B 在飞件是 D1-D3 的直接上游**：`ep-connector.mjs` 的 `forward(session, text)`（续轮不落库只 spawn——「router 是唯一落库口」的双写防护语义）恰是 callback 结果注入的天然通道；`/api/tree`+`broadcastAll` 是调用发布「进事件流」的现成面。D1-D3 施工单写依赖时应点名这些在飞接口，等 P2B 收账后核对签名。

---

## D1 契约工具面（portalk-t extension 注册 callback tool）

### 依赖

- **pi extension 注册机制（仓外 runtime，已满足）**：`pi.registerTool()` 声明式注册（TypeBox 参数 schema→JSON Schema 形状），载入期与启动后（热注册）均可，刷新即时可见可调——「声明式契约、函数体空、注册进 agent 工具面」的机制地基在。扩展放 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目本地）自动发现，`-e` 可测。
- **调用发布通道（仓内，已满足——形状可骑）**：`src/router.mjs appendSystemMessage`（system 消息直写 thread，不走三态）+ `src/server.mjs broadcast(threadId,…)`（WS 事件面，已有 `type:'ready'|'message'|'presence'|'pin-state'|'approval'|'shell-fault'|'error'` 枚举先例）。「调用发布到会话」可直接落 system 消息+广播，不发明新通道。
- **会话管道（仓内，已满足）**：`acp-adapter.mjs newSession/prompt(/forward 在飞)`——session↔thread 绑定（双指针国法）、每轮 spawn `--session-id` 续会话文件。callback 的挂起/恢复要借道这条管。
- **触感面（仓内，已满足但未收账）**：`reader.mjs` tool_use→task_progress + `heartbeat.mjs`（G1 在飞）TOOL_PHRASES 静态翻译——callback 调用在前端树上「看得见」的底料。注意 TOOL_PHRASES 未含 callback 工具族词条，D1 要补条。
- **契约注册正本（仓内，未满足）**：`db.mjs` 无契约表；`members/` 按 P0 定案不存 caps。谁持有契约正本（Portalk 持有是 D3/D4 的前提）完全空缺。
- **前端执行引擎（仓外，未满足）**：蓝图待办自列「浏览器能执行哪些契约、哪些要桌面 app」。验收判据 1 的执行半边不在本仓。

### 卡点

- **portalk-t 的宿主与家风冲突**：pi extension 是 TypeScript+TypeBox（从 pi 包 import）；本仓是零 npm 依赖 ESM `.mjs`+中文注释段。extension 源码住 portalk 仓还是 pianist runtime 仓？「零 npm 依赖」家规管不管 extension 文件？分发怎么走（Portalk 安装时拷进 `~/.pi/agent/extensions/`？）——蓝图一个字没提。
- **契约生命周期无定义**：谁起草（agent 会话中动态声明？）、怎么准入（P0 §5a 同款「准入归人类」要不要复用）、pi 侧热注册与 portalk 侧正本表怎么同步（extension 注册成功≠正本入库）。
- **调用发布的事件形状未定**：复用 system 消息（进消息库、可搜索）还是独立 WS 事件类型（`type:'callback'`，随 `approval` 先例）——影响日历翻阅/导出语义（审批/调用史进不进导出 markdown）。
- **跨机拓扑两难**（见总述横切发现 1）：单机形状先落=验收判据 1 改写；等媒人=P3 整体延期。

### grill 问题清单

1. 契约正本放哪、什么形状：DB 表（照 `db.mjs` seq 列 migration 先例）还是文件是真相（manifest 家风：文件可人读可 git）？agent 运行中动态声明的契约要不要「准入归人类」推审批（P0 §5a 同款），还是先跑后补？——这一问决定 D1 是薄注册面还是带审批回路的厚面。
2. P3 施工形状是不是先「单机桌面」（server 127.0.0.1+前端同机执行、agent 也在本机 runtime），把「琴师在云端」推迟到媒人层？若先单机，验收判据 1 如何改写才不放松「按契约委托、看得见、可拒」的语义？
3. portalk-t extension 归属拍板：源码住 portalk 仓（破 .mjs/零依赖家风）还是 runtime 仓（Portalk 产品面缺件）？「函数体空」的精确语义——是 execute 里只发调用+返回挂起占位（那它就不是空的），还是真无实现由壳外注入？
4. 工具遥控器面（零深度特例：通知/桌宠/推审批卡，无契约引擎无审批无挂起）要不要在 D1 的注册面里留位（同一张注册表、深度字段区分），还是严格后置？现在不留位，将来遥控器多半自起炉灶。

---

## D2 挂起/恢复（会话状态持久化）

### 依赖

- **会话文件续接（仓内，已满足——这是「借 pianist checkpoint」的真身）**：`acp-adapter.mjs` 每轮 spawn `--session-id` 续同一会话文件（文件头注释：「会话连续性挂文件不挂进程」）；`prompt/forward`（G3 在飞）续轮管道现成。挂起=进程已退场（`pi -p` argv 形状），恢复=新 spawn 续文件——「不占资源」天然成立。
- **【前提不符，未满足】workflow 级 checkpoint**：pi 无 Temporal 式挂起机制（核对结论见总述理由 1）。若 grill 拍板要「工具调用级挂起」（进程活着等结果），现有一切形状都不支持：要么 pi RPC 长连模式（`pi --mode rpc`，adapter 因 stdin EOF 坑账刻意绕开过），要么 pi 侧开「向会话树注入 toolResult」的新口（现无公开 API，`pi.sendMessage/sendUserMessage` 可注消息可 triggerTurn，但那是消息不是 toolResult）。
- **持久化底座（仓内，已满足——模式在表不在）**：`db.mjs ensureSchema`+幂等 ALTER（seq 列）migration 先例；挂起调用登记表照此加。
- **断线不丢（仓内，已满足）**：`messages.seq`+`GET /api/threads/:id/messages?since=` 补拉（判据 3 件）——挂起期间事件不丢的既有机制。
- **结果注入通道（仓内在飞，G3）**：`ep-connector.mjs forward(session, text)` 续轮不落库——callback 结果注入的天然通道（结果不是用户原话，不该进 thread 消息库——与 G2 记忆提醒「只进 argv 不进库」同款语义先例）。
- **编排面底座声明（蓝图依赖，未满足）**：跨壳任务书要两态回执（送达/取件）+超时（24h 上报/3 天退回，消息中转 v0.1 已拍）——pending 表形状要预留。

### 卡点

- **挂起粒度未定义（分水岭）**：轮末挂起（callback 工具返回「已挂起」占位结果→本轮结束→结果到货新轮注入，全骑现有 adapter 形状）vs 调用级挂起（进程占资源，或需要 pi 开会话手术口）。蓝图「workflow 挂起（借 pianist checkpoint，不占资源）」两个词组互相打架——不占资源的唯一解是进程退场=轮末形状。
- **挂起状态正本与重启重建**：pending 调用横跨 pi 会话文件+portalk SQLite+前端三方；`ep-connector` 的 `sessions` Map、adapter 的 `openSessions`、server 的 `pinStates` 全是内存态——恢复流程必须从 DB 重建会话上下文，现仓零先例。
- **durable 边界未定义**：验收判据「挂起≥1小时后恢复，状态无损」——包不包括 server 重启？adapter 重启？整机重启？不写进口径就是不可证伪。
- **超时与孤儿策略空白**：挂 24h 无人执行/用户拒执行怎么浮上来（消息中转对任务书定了 24h 上报+3 天退回——callback 侧无对应）。
- **一轮多 callback 并发语义**：pi 并行工具执行模式下，同轮兄弟工具调用有第一个挂起时其余怎么办（extensions 文档明示 sibling 语义复杂区）。

### grill 问题清单

1. 挂起粒度拍板：轮末挂起（占位结果+新轮注入，机制改动最小、今天就能做）还是调用级挂起（RPC 长连进程=占资源违背蓝图原话；或 pi 开 toolResult 注入口=runtime 侧新需求）？——这一问定 D2 全部形状，建议轮末先行、调用级列为 runtime 需求单。
2. 恢复语义：结果作为消息注入（协议级——agent 知道 callback 约定，收到的续轮输入带结构化结果）还是 toolResult 注入（机制级——agent 无感，会话树形状完美但 pi 无口）？前者快但有协议泄漏风险（agent 得学会读约定），后者干净但依赖 runtime 排期。
3. durable 边界写进验收吗：≥1 小时挂起必须横跨 server 进程重启（建议必须——不跨重启的 durable 是假 durable；且这一刀顺带逼 P2 还债：pinStates 也该落库）？
4. pending 表要不要一步到位吃跨壳任务书（两态回执+取件方+超时字段），还是 callback-only 先行？编排蓝图已声明坐 D1-D3 当底座——现在不留两态位，任务书面进场就是改表迁移+状态机返工。

---

## D3 回传校验（输出 schema 校验，不过不恢复）

### 依赖

- **校验器（仓内，已满足但有坑）**：`src/jsonschema.mjs` 自写 JSON Schema 校验器（零依赖家风）——但只实现 8 个关键字（required/type/enum/pattern/uniqueItems/items/properties/minItems），**$ref/const/additionalProperties/数值范围等不实现也不报错=静默视为无约束**。契约输出 schema 若超出子集，校验形同虚设。
- **契约 schema 正本（依赖 D1，未满足）**：校验的 schema 从 D1 注册面取。
- **恢复路径插针位（依赖 D2，未满足）**：「校验不过不恢复」嵌在 D2 恢复闸上。
- **失败出声面（仓内，已满足）**：system 消息+WS error/事件面现成，校验失败可呈现。

### 卡点

- **「不过不恢复」之后呢**：无重试/死信/用户修正通道定义。挂起调用校验失败=永久挂起？还是失败回执也是合法恢复（agent 收结构化失败自决）？
- **校验位置未定**：server 恢复闸统一校验（信任随正本——契约正本归 Portalk）vs extension/agent 侧自校验（执行者信自己声明——但那校验就没意义）。跨壳任务书的回传校验（编排蓝图 edge artifact schema 指针）应该同一套。
- **schema 表达力缺口**：TypeBox 可产全量 JSON Schema，portalk 校验器吃子集——超子集 schema 注册时是拒（好）还是静默弱校验（坏，现状行为）。
- **体量边界**：`MAX_BODY` 5MB/`MAX_FRAME` 16MB（server.mjs）——「读桌面文件」类契约结果可能超限；分块/落盘+指针回传策略未定。

### grill 问题清单

1. 校验不过的处置语义：失败回执是不是合法恢复态的一种（agent 收到 `{error:'schema-mismatch', details}` 自决重试/换参/求助用户）？死信态（多次不过/超时+不过）要不要进 pending 状态机，谁消费死信？
2. 校验器覆盖面与「可校验性预检」：契约注册时做 schema 子集预检（超子集拒注册）要不要做？不做=静默放行漏洞；做=agent 声明契约时即时反馈，代价是 D1 注册面多一道闸。要不要顺手扩 jsonschema.mjs（min/max/additionalProperties 至少三件）？
3. 校验权放哪：server 恢复闸（跨壳任务书与 callback 同一套，正本随 Portalk——但 hermes 侧执行的结果也过 Portalk 闸吗，跨用户边界时呢）？这与审批架构「Runtime 闸降级为纯执行者」是同一个信任分层的两面，要不要一次拍齐？
4. 结果体量：5MB/16MB 够不够「读文件」契约？超限走「结果落盘+回传指针」的规则（谁落盘、指针权限、盘上生命周期归谁清）要不要 D3 一并定？

---

## D4 审批同权（callback 走普通调度通道过闸+进事件流）

### 依赖

- **事件流（仓内，已满足——形状可骑）**：server 广播 `type:'approval'` 枚举先例（现仅用于 pinned-shell 路由事件）；G1 在飞件的 `broadcastAll` 可推全局面。审批通过/驳回进不进消息库待定（见 grill 4）。
- **壳审批面（仓内，半个满足——读有写无）**：`acp-adapter.mjs` 轮询 `GET /approvals/pending` 只读浮卡（注释原话「本单只读；批/驳写面 P2」）；mock-shell 同形状。批/驳写通道（POST 回壳）P2 未交付。
- **pi 侧工具闸（仓外机制在，件未建）**：extension `tool_call` 拦截可 block/可改输入（「permission-gate.ts」官方示例即此形状）——「pianist 审批卡改造」的挂点。注意 `pi -p` 无头模式下 `ctx.ui.confirm` 不可交互，审批必须走壳队列（8770）或 portalk 前端卡。
- **D1 契约面（未满足）**：闸要有对象——callback 工具先注册进工具面，闸才拦得到。
- **审批历史写 spoor（蓝图定案，仓内未满足）**：授权历史进 spoor 账本（append-only 审计永不删）——本仓零 spoor 实现，写通道依赖壳桥（`PIANIST_SHELL_URL` 的 spoor_* 动作，机制在）或 D6 的 SDK 路线前置件。

### 卡点

- **「同权」的执行者是哪个闸**：审批架构图画了三个执行者（hermes consent 闸/pianist 审批卡/Portalk callback 闸）；P3 蓝图说「callback 走普通工具的调度通道」。「普通调度通道」在 pianist 侧=壳审批队列——那 Portalk callback 闸是独立第三个闸还是就是「经由壳卡的呈现层」？两图一文本三个说法，grill 必须收敛。
- **裸奔窗口**：D2/D3 机制先行、D4/D5 后到之间，callback 通道存在但无判据无硬闸——必须有过渡防线（默认拒/白名单契约），否则等于开了一条绕人审的洞（蓝图自己警告过：「transport 类东西最容易开的洞」）。
- **审批卡到附着客户端的呈现**：审批事件现只广播到 thread 连接（`broadcast(threadId)`）；执行侧在前端（仓外前端线）——卡面契约文本、风险位（机器可判属性位来自 D5 正本）的呈现格式跨仓。
- **跨用户边界未拍**（审批架构留白原样遗传）：任务书发给太阳哥的壳时审批链谁批——callback 版同题（琴师跨机操作的是甜心机器，主权清楚；跨壳任务书的接收侧主权不清）。

### grill 问题清单

1. 「审批同权」精确语义：等于「同一张卡」（callback 卡与本地工具卡同队列出同一前端）还是「同一份契约语义、各自执行者的卡」（Portalk 只保正本和语义位，呈现归各 runtime）？这决定 D4 是做通道还是做正本+适配层——工作量差一个量级。
2. 裸奔窗口怎么封：D2 落地到 D5 判据到位之间，callback 契约注册面要不要硬闸默认拒（仅显式白名单契约可执行）？还是 D4 先内置最小硬闸子集（rm/对外发声/付款三件，硬闸清单 v0.1 的核心）顶着——后者等于把硬闸清单提前收进仓。
3. 授权历史记谁的账、走谁的道：spoor 写通道走壳桥 HTTP（依赖 pianist runtime 在场——hermes 主导的 callback 也得经 pianist 壳记账？）还是 Portalk 自带 spoor 客户端（=D6 SDK 路线前置）？闭源多租户版这笔账还归不归 spoor？
4. 「自动进事件流」的口径：审批通过/驳要不要作为 system 消息进 thread（日历可翻阅、全文搜索可命中——审批史可审计）还是只进 WS 事件不留库？前者吃搜索导出面（现成），后者轻但审计算 absent。

---

## D5 大白话判据文件（正本归 Portalk）+ 会话级同意积累

### 依赖

- **正本存储（仓内，模式已满足、件未建）**：manifest 家风先例——文件是真相+`loader.mjs` 校验+黄灯拒载（members/ 全套）。契约文件可同形状落（data/ 或 members/ 旁），但零文件零 schema 现存。
- **编辑回路（审批架构 v0.1，未满足）**：最小 diff+三行对照+暂存区+卡片批/驳——依赖审批卡写通道（同 D4 的写面缺口）+对话壳捕获编辑意图（LLM 层，仓外）+「编辑契约本身也要过审批」的自举。
- **现读现裁读取适配层（仓外挂点在，件未建）**：pianist=extension `tool_call` 钩子现读契约文件（「pianist 审批卡改造，与 D6 埋点同批」——蓝图明示时序）；hermes consent 闸完全仓外。
- **硬闸清单 v0.1（不可考）**：蓝图待办自认在「桌面 Portalk-硬闸清单-v0.1.md」——**不在真相源目录**（data/p2b-selforg-20261122/ 十份文件里无它，ls 核过）。三明治的底层内容缺失。
- **会话级同意的内存态先例（仓内，已满足）**：adapter `openSessions`/ep-connector `sessions` 均内存会话账——「故意不持久」的形状有先例，但「同类批一次」的分类学零定义。
- **授权两面分家（依赖 D4 的 spoor 通道，未满足）**：历史进 spoor/资格进契约文件/同意留内存——三个去处两个依赖上游。

### 卡点

- **裁决引擎未定义（最深）**：灰区操作「LLM 判断层现读现裁」——谁跑这个 LLM？审批架构定「翻译者=用户自己的对话壳，产品不追加 LLM」，但**裁决不是翻译**：判断「这个操作可不可逆、踩不踩条款」是模型活还是规则活？现读现裁的延迟（读文件+可能一次模型调用）挂在每次灰区工具调用上，与心跳树「零延迟保进度」的同款逻辑冲突。
- **契约 schema 双笔问题**：一句人话（用户聊天改）+机器可判属性位（可逆/作用范围，谁标？）——用户改人话后属性位谁同步？属性位标错的爆炸半径靠硬闸兜——硬闸清单还缺位。
- **「同类」的分类学**：会话级同意按什么聚合（工具名级/契约条款级/参数模式级）——粒度粗=漏审面大，细=骚扰。「批一次读桌面文件」=本会话任意路径任意文件？
- **与 P0 perms 三域的关系未声明**：manifest perms 是路径 ACL（project/interact/dialog，管「能碰哪」）；判据文件是行为契约（管「碰之前问不问」）——两套权限语言并存，schema 层不显式声明边界迟早混。
- **撤销即时生效=无缓存**：性能模型（每次灰区调用文件 IO+可能模型调用）在心跳树「进度实时」语境下的代价未估。

### grill 问题清单

1. 裁决引擎与尺子：可逆性判断是代码可判（写死的操作类别映射——快但僵）还是模型判（准但慢且贵且各家模型标尺不一）？分界线画在哪（哪类操作进代码层、哪类进模型层）？裁决要不要也走「翻译者=对话壳」原则（Portalk 只供语义位不跑模型）？
2. 判据正本形状与家法：文件是真相还是 DB？双笔编辑（人话归用户、属性位归 agent）+禁整文重写（审批回路同款教训）要不要复用同一套 diff/溯源机制？还是判据文件干脆单笔（属性位由系统从人话推导——推导错了谁兜）？
3. 会话级同意的「同类」怎么聚：按契约条款聚（批「读文件」条款=本会话全部读）还是按工具+参数模式聚？有没有 EP 审批卡历史数据可统计定档（过度授权面 vs 骚扰频次的量化）？
4. 硬闸清单缺位怎么办：D5 施工前先把 v0.1 从桌面收进真相源过 grill，还是 D5 连同硬闸清单一起 grill（一次过完三明治全层）？没有底层的三明治是两层果酱——爆炸半径兜底是空的，这决定 D5 能不能独立施工。

---

## D6 pianist runtime 第二份 spoor 埋点（SDK 路线第一步）

### 依赖

- **事件源（已满足）**：pianist 遥测管道全链在——pianist-tools 扩展 POST `/telemetry/ingest`（真链，`test/mock-pi.mjs` 注释佐证形状照抄真壳）→ `reader.mjs` tail 消费（TOUCH_KINDS 六种、tool_use/message_end 映射、classifyToolUse 钩子）。事件粮充足。
- **写通道（机制已满足）**：壳桥 spoor_* 动作（spoor_journal/spoor_status 等，[amber] 进写队列）经 `PIANIST_SHELL_URL` 可写——adapter 已有 shell 轮询先例（`acp-adapter.mjs` pollApprovalsOnce 的 fetchImpl 注入形状可复用）。
- **对账参照系（未满足，仓外）**：hermes 第一份埋点的事件格式——不在本仓不可考。「两壳事件对账：格式 diff 语义等价」（P3 验收判据 3）没有参照系。
- **范围明确（蓝图已定）**：本步只埋点不 SDK 化（三步路线第一步），分发配套=现成 spoor-ops——范围锁死，无蔓延风险。

### 卡点

- **埋点位置**：pi extension（pianist-tools 加 tool_call/tool_result 钩，有会话上下文）vs 壳 ingest 侧（单一挂点但只有遥测行、丢会话语境）——位置决定事件粒度与丰富度，也决定与 D1 portalk-t 是同一个件还是两个件（extension 蔓延要不要设合并预算）。
- **粒度即产品决定**：每 tool_use 一条=账本洪水；每 session 收尾一条=丢过程。spoor 的 mark 分类（判断/数据/坑/待审）已有——哪些事件配哪些 mark、哪些根本不配自动记（坑和判断按家法该 agent 手记——自动记了反而稀释信噪）。
- **敏感面**：遥测 input 字段可能带文件内容/命令行/参数——原样进 spoor=把敏感面从本地遥测搬进（未来可共享的）账本。脱敏规则未定。
- **幂等/重放**：reader `startAt:'beginning'` 重放、adapter 重启重挂、日界 linger——埋点侧若无去重键，append-only 账本直接污染。spoor 是 append-only 永不删，写错没有回头路。
- **「第二份」的验证口径**：等价验证需要 hermes 侧配合跑同场景——跨 runtime 协调成本不在本仓控制内。

### grill 问题清单

1. 埋点挂哪层、和 D1 什么关系：extension 层（上下文富、与 portalk-t/审批卡改造同一批扩展基建——三个钩子一个件还是三个件？）还是壳 ingest 侧（薄但哑）？extension 数量要不要设上限（runtime 侧每蓝图一个扩展会蔓延成灾）？
2. 自动记的粒度：「工作账」形状（session 级摘要自动+坑/判断 agent 手记——机制薄价值高）还是「全遥测镜像」（tool_use 级——对账容易但账本爆炸）？SDK 路线第二步要沉淀的「格式」到底指哪个粒度——这步不定，spec 沉淀的是错的参照系。
3. 敏感面脱敏规则要不要现在写成 spec 的一部分（input 参数进不进账本：进=审计完整、不进=对账失真）——还是第二步格式沉淀时再定（=先污染后治理，append-only 账本没有后悔药）？
4. 对账判据的可证伪性：hermes 事件格式快照要不要本单顺带收进真相源目录？不收，验收时「格式 diff 语义等价」连参照系都没有，判据不可证伪。

---

## 研判局限（评审员须知）

- hermes 侧实况（consent 闸形状、第一份埋点格式）与前端线（附着客户端/执行引擎）不在本仓，相关依赖只能核到「机制存在与否」层，核不到接口签名层。
- 硬闸清单 v0.1 在桌面不在真相源目录，D5 底层内容按缺位处理。
- pi runtime 文档（仓外 `/root/portalk-runtime/…/docs/`）作为 D1/D2/D4 依赖依据已核鲜度（本日），但 runtime 版本迭代快，施工单落笔前应复核 `registerTool/tool_call/sendMessage` 三口签名。
- P2B 在飞件（G1/G2/G3）未收账：本报告引用的 `forward/broadcastAll//api/tree/memoryReminder` 接口以工作区现状为准，收账后如有签名变动，D1-D3 依赖节需对表。
