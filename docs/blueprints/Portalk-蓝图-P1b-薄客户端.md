# Portalk 蓝图 P1b：Pianist 薄客户端（ACP 形状）

> 2026-11-16 照照起草 | 施工总图 v0.2 的 P1b 蓝图件
> 状态：grill 三问全清（Q1/Q2/Q3 定案 11-16~17）——schema 定稿可进施工
> 分工：设计不确定处 grill 甜心，工程选型照照判断（本文标注【选型·可推翻】的均为我的判断）
> 消费方：P2 接线测试（前端↔Server↔connector↔Pianist 消息闭环的引擎侧）、P0 manifest 实例化、P1a 消息闭环
> 上游：P0 成员位（Pianist 的 manifest 身份）、P1a thread（消息挂哪）

---

## 1. 这层交付什么

一个 ACP 对齐的 adapter，把 Pianist 变成 Portalk 内置的第一个 ACP agent——「永远在线的默认身体」。四个形状：

- **session new**：开一段 Pianist 会话（挂 thread）
- **prompt**：user 消息进 thread（P1a appendMessage）并送达 Pianist
- **update stream**：Pianist 的工作过程（工具调用/输出）实时流回前端
- **permission request**：Pianist 的审批卡（工具闸）浮上前端，user 批/驳

它不是新引擎——Pianist runtime 的壳（8770 审批/写队列）、遥测（JSONL）、驱动器（v2.3）全是现成的。薄客户端=在 portalk 侧包一层 ACP 语义的 adapter，把这些现成能力翻译成 ACP 四形状。

## 2. 定案回顾（不再重议）

- Transport（11-15 甜心）：不走堂屋轮询；前端↔Server 持久长连（WebSocket）；connector 出站连接（用户侧不暴露端口，穿 NAT）；引擎内嵌 acpx（MIT）；adapter 对齐 ACP，官方 TS SDK 直接用。
- Pianist 是 Portalk 内置第一个 ACP agent + 永远在线的默认身体（未 pin 时消息第一顺位）。
- 依赖单向：portalk 知道 pianist，反向不知道（11-09 仓库结构定案）——adapter 住 portalk 侧，经 PIANIST_SHELL_URL 等既有通道说话，不改 runtime 内部。

## 3. 形状映射（ACP ↔ 现有 pianist runtime）

| ACP 形状 | 现有对应物 | 本层做什么 |
|---|---|---|
| session new | pi spawn（驱动器 v2.3 已会）+ conductor 常驻 | session 生命周期对象：session_id ↔ thread_id 绑定（P1a 双指针国法），spawn 策略见 Q1 |
| prompt | 消息进 thread + 送 pianist stdin/API | 消息路由：thread 消息 → session 输入；出话回写 thread（speaker_id=agent 身份） |
| update stream | 遥测 JSONL + F3 事件账 | reader v0 的触感事件（总图 P1a 节并入项）：工具调用/分身 spawn/exit 实时可读，映射 ACP update 序列 |
| permission request | 壳审批卡（/approvals/pending） | 卡浮上前端 → user 批/驳 → 回写壳；T5 pin 三态在本层接（壳故障双通知） |

【选型·可推翻】实现顺序：update stream 先行（reader v0 已并入 P1a 轨道，遥测→触感事件的管道是四形状里唯一已有半成品的），session new/prompt 次之（P1a 落地后才有挂点），permission request 最后（壳的审批 API 稳定，映射直接）。

## 4. 待拍板（grill 清单）

- **Q1 session 策略**【照照预判·待甜心点头】：**对话面按需 spawn，「常驻」不进架构。** 澄清三层：
  1. ACP 本身是客户端驱动协议（session new=客户端发起 spawn 子进程，stdio JSON-RPC，session 结束进程退场）——「常驻」在 ACP 语境里不存在。dm 唯一性是 thread 层的事（P1a），跟进程无关；session 硬切无感（判据 2）说的就是 thread 连续性不依赖 session 连续性。
  2. 「永远在线的默认身体」= 路由优先级概念（未 pin 第一顺位）+ thread 连续性，两层都不是进程常驻。有消息才呼吸=按需 spawn 天然形状。
  3. conductor 常驻是 pianist **自主面**的事（预算内常驻抽卡——甜心 11-16 纠正：非真常驻），跟**对话面**无关，两个面分开后互不牵连。自主驱动四件套（感官线/卡池/schedule/wrapper）是 pianist 专属超能力，**不是 Portalk 对所有 runtime 的要求**——别的 runtime 接进来就是「按需被调用」的 ACP agent，想自主驱动是它们自己 runtime 的事。
  4. 适配层成本（甜心 11-16 考察点）：每 runtime 一个**薄 ACP adapter**（spawn/stdio/审批卡映射，P0 已设计 adapter 直读 runtime 工具清单），这是必然成本且是薄翻译层；「连给所有 runtime」的厚适配（复制自主驱动）不存在——按需 spawn 方案下额外适配层为零。
- ~~Q2 update stream 粒度~~ ✅已定案（11-17 甜心）：**流式不做，token 流/打字机都不做。** 理由（甜心原话精神）：流式输出本来就是为了遮掩延迟，打字机效果会显得更延迟——干脆不做流式。前端她自做简单的「思考中/输入中」动效（归前端线，不进本层）。工具级遥测仍归 reader v0（P1a 轨道），供心跳树/触感面消费，只是不进对话渲染链。
- ~~Q3 旧仓摘取范围~~ ✅已定案（11-16 甜心）：**直接重写，零拷贝。** 理由：新版 Portalk 架构调整极大，旧仓实现万一耦合了别的东西，搬进新仓更麻烦；目标永远是尽可能低耦合，每个模块做干净。旧仓 fd91cf9 只作协议形状参考。

## 5. 判据（照抄总图+细化）

1. P0 manifest 的 pianist.yaml 实例能被本层消费（session new 成功挂 dm thread）。
2. P1a 消息闭环：user prompt → pianist 出话 → thread 落消息（speaker_id=身份 ID）→ 前端可见。
3. 工具级事件经 reader v0 可读（触感面消费：心跳树/分身 spawn/exit），**不进对话渲染链**（Q2 定案 11-17：流式不做）。
4. permission request：审批卡浮前端，批/驳真实生效（壳侧状态翻转）。
