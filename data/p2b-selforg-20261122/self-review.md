# P2B 自编排单 · self-review（G5——本单核心观测物）

- 编排者：pianist（本单主 agent）
- 日期：2026-11-22 · 总钟 60min（编排单宽限）
- 交付：G1 心跳树 / G2 记忆提醒 / G3 EP 真接线 / G4 P3 研判（分身）/ G5 本报告
- 基线纪律：动刀前 78/78 绿 → 收工 93/93 绿（+15 新增，0 新败）· `npm run check` 绿

## 1. 拆法

目标包五件按「冲突面」而非「清单序」分组：

| 瓣 | 内容 | 动的文件 |
|---|---|---|
| G1 心跳树 | 语义映射表+树状态机+server 数据面 | 新 src/heartbeat.mjs；server.mjs 加 /api/tree+broadcastAll |
| G2 记忆提醒 | 权限位+豁免链+注入点 | members/schema.json 加 prefs；acp-adapter.mjs 加 memoryReminder+prompt0 拼接 |
| G3 EP 接线 | epForwardStub→真身 | 新 src/ep-connector.mjs、src/compose.mjs；acp-adapter.mjs 加 forward/taskPreStored |
| G4 研判报告 | 六条 D 依赖/卡点/grill 问题 | 只写 data/p2b-selforg-20261122/p3-pregrill-report.md |
| G5 本报告 | 编排决策复盘 | 本文 |

关键设计决策（施工中现形，非任务书给定）：

- **G1 数据面双口**：HTTP `GET /api/tree`（快照/轮询）+ WS `{type:'tree'}`（onChange→broadcastAll 推送）。理由：WS 秒级可读（判据 5「秒级」的直解），HTTP 快照兜断线重连（与判据 3 的 since 补拉同构）；树是全局面（agent 活动跨窗口），广播不挑 thread 门牌。
- **G2 注入点**：只进 spawn argv 不进 thread 库（库里永远是用户原话——提醒是给 agent 的不是给对话史的）；「恰一次」的闸=newSession 唯一（prompt 续轮天然不带）。Pianist 豁免做硬规则（代码里 slug==='pianist' 恒 null），不靠配置缺省——判据 7 的「Pianist 不吃提醒」因此不可被误配绕过。
- **G3 防双写**：routeMessage 是唯一落库口（三态共通铁则），故 adapter 侧加 `taskPreStored`（newSession 跳过首轮落库）与 `forward`（续轮不落库只 spawn）两个口——EP 转发场景 adapter 退为纯引擎。顺带发现并补上「组装层回话回流」：adapter 出话是静默落库，无它则 WS 窗口看不到回话（消息闭环的下半边缺角）。
- **G3 失败语义**：epForward 自吞异常记账（stats.errors/lastError）不上抛——server 同步调 epForward 未 await，上抛即 unhandledRejection；消息已进库已广播，转发失败=出声面不是崩局面。

## 2. 为什么 spawn 1 个（不多不少）

**派出的 1 个**：G4 研判报告。理由三条：
1. 零代码冲突——唯一写入是独立 md 文件，与我并行的代码瓣互不碰；
2. 纯读+写任务，上下文自足（九份真相源+仓内实码都在文件系统里），不需要与我共享施工上下文；
3. 它是长任务（读十份文档+对照实码），派出后与我写代码真并行——这是我手里唯一的「并行收益>协调成本」切分。

驱动器：tools/p2b-g4-dispatch.mjs（照 copycat-v6 形状：buildRuntime+launchMinion+交货单收口），分身 cwd=/root/portalk，runtime 台账全注入 /tmp（不污染工作仓）。任务书只给目标/真相源/验收（六条 D 三节+对照实码），不教方法——与本单实验条件同构。审链：角色表声明「审链:评审员」，runtime completionPump 自动派 glm-5.3-flash 评审分身出 verdict=**pass**（收口读数：12min 交货2）；编排者终审（复验：三节齐✓、实码点名抽查三处全真✓、无幻觉形状✓）。

**不派的 3 个**：G1/G2/G3 全自干。理由：
1. **改动面交叠是硬伤**：G2 与 G3 都动 acp-adapter.mjs 的 newSession/prompt 邻域（记忆注入 vs taskPreStored/forward），G1 与 G3 都动 server.mjs（/api/tree vs 组装接线）。并行分身写同一文件=互覆（环境明示 twin 风险），且本单不 commit——没有 rebase 收口面，合并只能人肉对账，60 分钟钟里这是最亏的赌注；
2. 粒度不够：三瓣各 ~150-250 行（码+测试），单瓣 spawn/验收/合并的编排开销占比过高，分身的价值在长上下文隔离，不在行数；
3. 审链成本：代码瓣的行为级断言我可以直接跑突变验证（见 §4），派分身反而多一层「它的测试它自己绿」的信任转手。

## 3. 审链怎么挂

- 代码瓣（G1-G3）：node --test 行为断言 + **突变实验收口**（一瓣一灵魂，见 §4）——测试有效性不靠自信靠拆件验红。存量面（78 条）全量回归当护栏。
- G4 分身：runtime 自动审链（评审员 verdict）+ 编排者终审（三节结构、实码点名、局限声明三样核过；分身自报「研判局限」节——诚实度信号良好）。
- G5：无审链（自述物，交照照复验）。

## 4. 突变实验记录（一瓣一灵魂）

方法：备份→单点突变→跑对应测试→验红→还原→验绿→最后全量回归。

| 瓣 | 突变（拆什么） | 结果 | 灵魂断言 |
|---|---|---|---|
| G1 | TOOL_PHRASES 查询空转（for of []+匹配短路） | 5 红 1 绿 | 「在跑命令/在读文件」语义断言红——树面黑话化即败 |
| G2 | prompt0 拼接拆除（提醒不进 argv） | 2 红 3 绿 | 「恰一次送达 agent」断言红（会话文件里找不到提醒） |
| G3 | forwardOnce 空转 return null（不流向 EP） | 3 红 1 绿 | 转发计数/回话落库/续轮断言红 |

绿的那几条是结构测试（树形状/裁决函数单测/三态 unit），不依赖被拆件——恰说明灵魂断言与结构断言分层干净。还原后 93/93。

## 5. 踩的坑（施工实录）

1. **TDZ**：remindText 块引用 resolvedIdentity 但声明在其后——node --check 不报（语法层），import 时才爆。教训：构造区变量重排后必须跑一次真 import。
2. **session.wait 没接**：forwardOnce 里 newSession resolve 不等子进程退场，出话回写挂在 session.wait() 上没人调——症状是「转发计数+1 但 agent 回话不落库」。debug 三轮（spy 注入→相对路径 mock-pi 排除→until 轮询定位）才锁到。修法一行：`await session.wait?.()`，顺带把 compose 回话回流也救活了。
3. **测试没走真实形状**：ep-connector 初版测试直接调 epForward 断言库里恰一条 user——0!==1。根因：epForward 设计前提是 routeMessage 先落库，测试绕过路由=测了个不存在的链路。重写测试走 routeMessage 真形状（fire-and-forget+until 轮询等异步链）。
4. **casting-sheet 必填段**：驱动器首跑即死（缺「验收标准」段）——runtime 的任务书 schema 比我预期严，这是好事。

## 6. 重来会怎么改

- **驱动器先自检再点火**：casting-sheet 的必填段校验（角色表/预算袋/验收标准）应先 dry-run parse 再 spawn——首跑即死浪费一轮。若重来，G4 点火会提前 5 分钟。
- **G3 的 compose 组装层应该一开始就立**：我先写 ep-connector 测试再发现「回话不广播」缺角，中途插组装层导致测试重写一次。教训：凡是「把零件接成活线」的单，组装层的接口（谁广播、谁落库、谁等退场）该在动第一行 src 前先画——三瓣的缝都在组装层。
- **G2/G3 同文件改动可考虑「先 G3 后 G2」**：G3 的 taskPreStored 改了 newSession 落库语义，G2 的注入又叠在 spawn 行——两改叠加时我改了三遍同一段。若分身路线走得通，acp-adapter 的三处增量（memoryRemind/forward/taskPreStored）应合成一次手术。
- **时间账**：约 30 分钟完成代码瓣+突变，5 分钟驱动器（含一次翻车重试），G4 分身与代码瓣真并行（零等待）。剩余预算花在复验与本文。单分身+自干的形状在 60 分钟钟里刚好不空转——若任务再大一档（如 P2 判据 6 也归我），会考虑把 G1 的 server 集成面也派出去（server.mjs 的树端点与 G3 组装层可拆干净）。

## 7. 交付清单

- src/heartbeat.mjs（+test/heartbeat.test.mjs，6 测）——G1
- members/schema.json prefs 位 + acp-adapter.mjs memoryReminder/注入（+test/memory-remind.test.mjs，5 测）——G2
- src/ep-connector.mjs + src/compose.mjs + acp-adapter.mjs forward/taskPreStored + server.mjs /api/tree（+test/ep-connector.test.mjs，4 测）——G3
- data/p2b-selforg-20261122/p3-pregrill-report.md（分身产，28.5KB）——G4
- 本文 + tools/p2b-g4-dispatch.mjs（分身驱动器，留仓复用）
- 全套：93/93 绿 · check 绿 · 三瓣突变验红还原绿 · 不 commit 留工作区
