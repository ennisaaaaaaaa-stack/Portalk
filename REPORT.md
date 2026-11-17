# 施工报告：Portalk P1b Pianist 薄客户端（ACP 形状）（新仓第二单）

> 施工：pianist（琴师分身）· 2026-11-17 · 蓝图：`/tmp/portalk-p1b-blueprint.md`（grill 三问全清 11-16~17，正本未入仓——仓内只有 P0/P1a 两份）
> 状态：完工待复验。**未 commit**（按纪律留工作区）。零 npm 依赖（纯 Node 22 内置）。
> 首单报告（P0+P1a）见 `git show e2bf6d0:REPORT.md`。

---

## 1. 交付物清单

| 文件 | 内容 |
|---|---|
| `src/reader.mjs` | reader v0：遥测→触感事件管道（tail 增量、跨日界切换+linger 兜底、截断重置、classifyToolUse 钩子） |
| `src/acp-adapter.mjs` | Pianist ACP adapter：session new/prompt/close 四形状 + 审批轮询 + P0 身份消费 |
| `bin/portalk.mjs` | 扩展 `acp demo` 子命令（全链演示，真链护栏超时）；无子命令时首单行为不变 |
| `test/mock-pi.mjs` | pi 子进程替身（落会话文件/续轮追加/上报遥测/HANG 不退场） |
| `test/mock-shell.mjs` | 壳替身（listen(0) 内核挑口；/approvals/pending + /telemetry/ingest 同真壳形状） |
| `test/reader.test.mjs` | reader 9 测 |
| `test/acp-adapter.test.mjs` | adapter 12 测（含 P0 消费、审批浮出/去重/容错、HANG 杀进程） |
| `test/demo-smoke.mjs` | acp demo CLI 全链冒烟（手动跑，不进 node --test 主链） |
| `package.json` | check 扩 4 文件；description 更新 |
| `REPORT.md` | 本件 |

测试账：首单 46 测零回归 + 新增 21 测 = **67 测两遍绿**。

## 2. 蓝图条目 → 文件 → 测试对照表

### P1b §3 形状映射（四形状）

| ACP 形状 | 蓝图现有对应物 | 本层落点 | 测试 |
|---|---|---|---|
| **session new**：pi spawn（驱动器 v2.3 已会）+ session 生命周期对象，session_id↔thread_id 绑定（P1a 双指针国法），spawn 策略 Q1（按需 spawn 无常驻） | adapter `newSession`：spawn `pi -p --model zai-coding-cn/glm-5.2 --session-dir <D> <task>`（驱动器 v2.3 同款 argv 形），session_id=pi 会话文件名 uuid（发现法见偏离-2）；thread 缺省=dm 建连（P1a createThread 复用恰一）；user 消息经 appendMessage 落库带双指针 | acp-adapter 测「newSession：dm 建连…session_start 事件」「复用既有 dm」 |
| **prompt**：消息进 thread + 送达 pianist；出话回写 thread（speaker_id=agent 身份） | adapter `prompt`：appendMessage(user) + 续轮 spawn（`--session-id` 续同一会话文件）+ 退场后 appendMessage(agent, stdout 回话) | acp-adapter 测「prompt 续轮：--session-id 续同一会话文件…」「完整轮：替身回话落库（speaker=agent 身份）」 |
| **update stream**：reader v0 触感事件，工具级实时可读，映射 ACP update 序列（**不进对话渲染链**，Q2 定案流式不做） | reader.mjs：`tool_use→task_progress`、`message_end→heartbeat`，event={shell:'pianist', kind, ref, detail} 触感标准形状；无 token 流/打字机 | reader 9 测（映射/tail/跨日界/秒级延迟腿）+ acp-adapter「update 事件」全链测 |
| **permission request**：壳审批卡 `/approvals/pending` → 卡浮前端（本单只到回调层；批/驳写面 P2） | adapter 审批轮询：interval 可配，按 id 去重（新卡恰浮一次），壳不在场/坏响应容错继续轮（壳故障双通知=P2 T5） | acp-adapter「审批轮询：新卡浮出恰一次（去重）」「容错：404/坏 json 不炸不停」 |

### P1b §5 判据

| 判据 | 落地与验证 |
|---|---|
| 1. P0 manifest 的 pianist.yaml 实例能被本层消费（session new 成功挂 dm thread） | `resolvePianistIdentity({membersDir})` 经 loader.mjs 读出厂件取 agent_id；真链 demo 首行 `members ok：pianist=a:b7c2e9f4a1d83c60` 即消费实证；测「resolvePianistIdentity：从出厂成员位解析」用仓内真出厂件（拷私有目录隔离） |
| 2. P1a 消息闭环：user prompt → pianist 出话 → thread 落消息（speaker_id=身份 ID）→ 前端可见 | 真链 demo 收尾打印 thread 账本 2 条：`p:tianxin（user）`+`a:b7c2e9f4a1d83c60（agent）`，speaker 全为身份 ID；mock 测「完整轮」「prompt 续轮」钉死轮次序列 |
| 3. 工具级事件经 reader v0 可读（触感面消费），不进对话渲染链 | 真链 demo 事件流：`heartbeat tokens=4241 cost=0.001333`（真遥测）；reader 测「start/stop：秒级可读」钉延迟 <1s；对话渲染链零接线（无任何 token 流面——代码里没有，不是没测） |
| 4. permission request：审批卡浮前端，批/驳真实生效（壳侧状态翻转） | 浮出半环本单交付：真链 demo 浮出 11 张真壳卡（含本单施工中被闸拦的 `rm -rf` 卡自身——read-only 消费，未批未驳）；批/驳写面按任务书归 P2 |
| 任务书判据（reader）：spawn/exit 事件延迟秒级可读 | session_start 在 spawn+发现后立即发（demo 时间线：发现即发）；reader 缺省 500ms 节拍+start 立即首巡；测腿断言 <1000ms |

### 任务单施工面逐项

| 施工面 | 落点 |
|---|---|
| session new：spawn pi 子进程，按需 spawn 无常驻 | `newSession`——每轮 spawn，无常驻进程，session 生命周期挂会话文件不挂进程 |
| session_id=pi 会话文件名 | 快照差分发现 `<ts>_<uuid>.jsonl`，uuid 即 session_id；真链实锤 `2026-11-16T17-10-54-733Z_01a1e557-…jsonl` |
| prompt：消息进 thread+送 pianist | appendMessage(user)+argv 送话+退场回写 appendMessage(agent) |
| update 事件：watcher 盯遥测 mtime+尾行映射触感标准 | reader 盯 `<agent>-<UTC日>.jsonl` size 增量（mtime 等价信号，见偏离-4） |
| permission：轮询壳 interval 可配，新卡→回调浮出 | `approvalIntervalMs`（缺省 2000ms），`onApproval(card)` 回调即消费面 |
| session 结束：close 事件+进程退场，thread 连续性不依赖 session | `close()`：SIGTERM 兜底+session_end 事件；测「close 杀活进程」「复用既有 dm：session 硬切 thread 连续」 |
| CLI `acp demo --thread <th:uuid> --task "..."` | `--thread` 接既有窗口（裸 uuid 自动补 `th:`），缺省 dm 建连；全链演示五段齐 |

## 3. 偏离清单（逐条，代码注释均有标注）

1. **stdin 保持开 → 推翻，task 走 argv + stdin ignore**【任务书自标选型·可推翻】：坑账先例（spoor portalk 2026-10-22）pi -p 等 stdin EOF 才开工，stdin 保持开=子进程死等；驱动器 v2.3 生产形状是 argv 送话+`stdio:['ignore','pipe','pipe']`。本层照生产先例，后续轮次用每轮新 spawn+`--session-id <uuid>` 续同一会话文件（会话连续性挂文件不挂进程——恰是 P1a 判据 2 语义）。
2. **session 文件发现=spawn 前后目录快照差分，非 mtime 扫描**：本仓 cwd=/root/portalk 正有别的 pi 会话在跑（施工分身自己），其会话文件 mtime 持续更新，mtime 法会误抓。差分只认新文件名，且校验首行 session header 的 id 与文件名 uuid 一致。
3. **subagent_spawn/subagent_exit 保留位，未映射**：遥测只有 tool_use/message_end 两 kind（11-08 spoor 已证），无原生 spawn/exit 行；reader 留 `classifyToolUse` 钩子（默认全判 task_progress），分身事件分类待 P2 接 conductor F3 事件账再定。判据 3 的「工具级事件可读」不受影响。
4. **盯尾用 size 增量非 mtime**：mtime 粒度/更新语义与 size 等价（追加才有新字节），size 判重读更省一次 stat 往返；任务书「mtime+尾行」的意图（只在有新增时读）不变。
5. **user 消息落库以 session 发现为闸**：双指针国法要求 session_id 必填，发现超时（20s 可配）=杀子进程+抛错，不落消息不造假指针。代价：user 消息持久化晚于 spawn 约 0.2~2s（发现轮询 150ms 节拍），可接受。
6. **reader startAt:'beginning'（adapter 内）**：遥测 agent 名每 session 独占（`pianist-acp-<短uuid>`），beginning 不会重放外来历史；只防事件先于 session 发现落盘的竞态（mock 测试里实测到该竞态）。
7. **审批卡 seen 集不回收**：卡消失（他处批走）后同 id 复现不重浮。id 复用=壳侧新卡的形状未在真壳观察到，P2 接写面时若有复用语义再改。
8. **`resolvePiBin` 三级链含本机装配位 `/root/portalk-runtime/node_modules/.bin/pi`**：demo 需要可执行 pi，仓内未装（零 npm 依赖纪律），env `PORTALK_PI_BIN` > 仓内 node_modules > 本机装配位 > PATH。硬编码装配位是本机部署事实，蓝图 §2「portalk 知道 pianist」的单向依赖语义不变。
9. **demo 冒烟脚本 `test/demo-smoke.mjs` 不进 node --test 主链**：CLI 端到端要保活 mock 壳且慢（~3s），挂主链拖全套；验收命令清单里手动跑（已绿）。

## 4. 新坑（入 spoor portalk 项目坑账）

1. **测试 env 泄漏到本机活壳**：adapter 的 shellUrl 缺省链会落到 `process.env.PIANIST_SHELL_URL`（本机=活壳 8770）。一处测试漏传 `shellUrl`/`env:{}` 时，轮询真壳浮出 10+ 张真产卡污染断言（实测 12≠1）——测试密闭纪律：凡构造 adapter 的测试必须显式传 mock 壳地址或空 env。
2. **共享 testdata 的并行测试竞态**：`ensureFixtures()` 是幂等清建（删了重建），node --test 默认并行跑文件——两个文件同时清建/读同一 testdata 目录会互咬（实测 loader 测随机红）。正法：读静态仓内件（members/*.yaml）或拷入私有 mktemp 目录，不在断言路径上重建共享夹具。
3. **reader 截断检测要在同趟重读**：`size<offset` 判截断若只重置 offset 不读，事件要等下一个节拍（测试慢一拍红）；检测与重读须同趟完成。
4. **真 pi 会话文件在启动即落盘**（model_change/thinking 条目触发 flush），快照差分发现窗 20s 绰绰有余；但前提是 stdin ignore——stdin pipe 会让 pi 卡在 readPipedStdin（坑-1 的镜像面：不只是不干活，会话文件都可能不落）。
5. **本机时区 CST、遥测日界走 UTC**：测试硬编码遥测文件日期踩过 2026-11-16/17 交界（UTC 还是 16 日）；凡涉日界的测试必须注入时钟（`now` 参数），不吃机器钟。

## 5. 真链验收记录（本单唯一真钱点）

```
node bin/portalk.mjs acp demo --db /tmp/portalk-acp-real-Od3hC0/portalk.db \
  --task "请只回一句话确认 Portalk ACP 链路已通，不要调用任何工具。"
```

- dm thread 建：`th:311e880e-2cce-4bc5-b9f1-077a9a7ac21c`（user=p:tianxin ↔ agent=a:b7c2e9f4a1d83c60，P0 出厂身份）
- 消息落库：2 条，speaker 全为身份 ID；agent 回话「Portalk ACP 链路已通。」
- 事件流：`session_start`（ref=01a1e557-200d-7639-b41a-5f8e21933fdc，真 pi 会话文件名 uuid）+ `heartbeat tokens=4241 cost=0.001333`（真遥测，本单零工具调用故无 task_progress——符合预期）+ `session_end exit=0`
- 审批卡浮出：11 张真壳卡（含施工中被闸拦的 ap_mwjik6nb_15——demo 把自己的拦截卡浮了出来，只读未批）
- 会话文件实锤：`~/.pi/agent/sessions/--root-portalk--/2026-11-16T17-10-54-733Z_01a1e557-200d-7639-b41a-5f8e21933fdc.jsonl`（蓝图路径形状逐字对上）
- 遥测实锤：`/root/portalk-runtime/data/telemetry/pianist-acp-15a61b2a-2026-11-16.jsonl`（活壳落盘，reader 读到）
- **花费：¥0.001333**（message_end usage，glm-5.2）

## 6. 验收自检（按施工单清单）

1. ✅ `node --test test/*.test.mjs` 全套两遍绿：67/67 × 2（首单 46 测零回归）
2. ✅ 突变可掰：拆 reader 日界切换（`if (false && s.file !== current)`）→「跨日界切换」腿红（复原绿）；拆审批浮出（注释 onApproval 调用）→「审批轮询」两腿红（复原绿）；复原后 diff 备份零残留
3. ✅ acp demo 真链一次：见 §5，exit 0 干净
4. ✅ 本 REPORT §2 对照表对上蓝图 §3/§5
5. ✅ `git status`：`M bin/portalk.mjs M package.json` + 新增 src×2/test×5，全部仓内；无越界

## 7. 跑过的命令清单

```bash
npm run check                                          # 全过（含新增 4 文件）
node --test test/*.test.mjs                            # 多轮，终态两遍 67/67 绿（另 5 连跑验证 flake 修复）
node --test test/reader.test.mjs                       # 单件调（9 测）
node --test test/acp-adapter.test.mjs                  # 单件调（12 测）
# 突变两瓣：
cp src/reader.mjs /tmp/reader.mjs.bak && <拆日界切换> && node --test test/reader.test.mjs   # 跨日界腿红
cp src/acp-adapter.mjs /tmp/acp-adapter.mjs.bak && <拆审批浮出> && node --test test/acp-adapter.test.mjs  # 浮出两腿红
# 复原 + diff 零残留
node test/demo-smoke.mjs                               # CLI 全链冒烟（mock pi+mock 壳，零真钱）PASS
node bin/portalk.mjs acp demo --db /tmp/portalk-acp-real-Od3hC0/portalk.db --task "…"      # 真链一次（§5）
node bin/portalk.mjs --db /tmp/portalk-cli-2/portalk.db # 首单行为回归（db ready + pianist 入树）✓
git status --short && git diff --stat                  # 越界检查
```

仓外动作报备：① spoor portalk 项目入账（本单判断+坑账五条，runtime 记忆层）；② `/tmp` 残留归照照：`/tmp/portalk-acp-real-Od3hC0/`（真链 db）、`/tmp/portalk-demo-smoke-*`（冒烟）、`/tmp/mockpi.sh`、`/tmp/reader.mjs.bak`、`/tmp/acp-adapter.mjs.bak`、`/tmp/portalk-cli-2/`。真链另生两件真账（非 /tmp）：pi 会话文件（~/.pi/agent/sessions/--root-portalk--/）与遥测行（portalk-runtime/data/telemetry/pianist-acp-15a61b2a-2026-11-16.jsonl）。
