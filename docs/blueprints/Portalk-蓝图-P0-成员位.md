# Portalk 蓝图 P0：成员位结构化数据

> 2026-11-15 照照起草 | 施工总图 v0.2 的 P0 蓝图件
> 状态：草案——schema 定稿后并入 `Portalk-成员位-manifest` 专档升 v0.2
> 分工（甜心 11-15 定）：设计不确定处 grill 甜心，工程选型照照判断（本文标注【选型·可推翻】的均为我的判断）
> 消费方：thread 表（成员字段）、消息（speaker）、pin 按钮（指定壳）、派活路由（caps 查询）、心跳树（结构骨架）、记忆提醒（memory_ref 探活）

---

## 1. 这层交付什么

manifest 从人读的文字树，变成机器可解析、可校验、可消费的 schema。Pianist 当第一个实例。

它不是新系统——是身份模型（manifest v0.1 五原则）的落地格式。五原则原样继承：树是视图不是存储、挂载非拥有、单模板人机同构、权限路径 ACL 不继承、运行时状态不进 manifest。

## 2. 选型【照照判断·可推翻】

- **格式：YAML，一成员一文件** `members/{slug}.yaml`。理由：人能直接打开读改（甜心可审）、git 友好、可注释；机器可解析。manifest 是信任根，必须是文件不是 DB 行（文件是真相）。
- **校验：JSON Schema**（`members/schema.json`，版本化）。conductor 载入时校验，坏了亮黄灯拒载，不静默。
- **运行时：conductor 启动载入 + 文件 watch**。内存树是视图；改文件即改树（经写权通道，见 §8-Q3）。
- SQLite 查询索引层：v1 不做，等有性能需求再加（索引是视图的视图）。

## 3. Schema v1

单结构+可选字段（人机同构：人类的枝空着=事实稀疏，不是模板分叉）。

```yaml
# members/pianist.yaml —— 第一个实例（出厂件）
manifest_version: 1
slug: pianist                    # 全局唯一（Twitter 模式已定案）
kind: agent                      # agent | human
agent_id: a:b7c2...              # 长形式身份锚（rename 换名不换 ID）
display_name: Emergence Pianist  # 默认名；人类可改（display_name 归人类填，slug 才是法律）

identity:
  memory:                        # kind=agent 必填；human 缺省（枝空）
    ref: tideline:///opt/portalk/ep/tideline/mcp_memory.db   # 协议://地址
    liveness: file               # 探活档位：file=能开+能读schema版本；不读内容
                                 # 【身份=记忆单一权威：speaker 记 agent_id，壳只记元数据】
                                 # ref 可指现有库（如照照指 WSL Tideline 活本，挂载非拥有）；
                                 # 开源版出厂=随包空库。换库=监护人动作，走账本事件 memory.repoint，agent_id 不变
shells:                          # 0..n 个挂载；每个=(provider, provider_ref) 独占
  - mount: pianist@local-default          # 挂载点名（本树内唯一）
    provider: pianist
    provider_ref: local-default           # 该 runtime 内的实例标识（claim 的 ref）
    claim_bound_at: 2026-11-15
    claim_bound_by: p:tianxin             # 监护人绑定（claims 先例）
    address: systemd:portalk-conductor    # 地址串，adapter 解释
    # 无 caps 字段——Portalk 不替 runtime 声明工具（11-15 定案），见 §5a

perms:                           # 三域独立，路径 ACL 不继承
  project: []                    # v1 空数组起步，语法见下
  interact: []
  dialog:
    - threads:own:*              # 默认自己的全部 thread

senses:                          # 感官枝：引用，非拥有
  - name: moonshine
    ref: moonshake:///opt/portalk/ep/moonshine/

vault:                           # 独立库（个人产物挂成员）
  diary: []                      # v1 可空
  opus: []
```

**权限路径语法 v1**（只定前两段，第三段出现真实需求再扩）：`{域}:{对象类型}:{对象}`——`project:ocean-listen`、`group:symposion`、`threads:own:*`、`thread:t:{uuid}`。

## 4. 不变量（conductor 启动校验，违者拒载）

1. `slug` 全局唯一；`agent_id ↔ slug` 1:1（改名走 rename 事件，ID 不动——ID 契约已定案）。
2. **壳三态（11-15 甜心定案）**：**有主**（挂某 agent id 下；该身份的多台壳全部共享同一个记忆库——身份=记忆单一权威，壳只记元数据）/ **无主**（不挂任何 id，挂山海工具面，任何 agent 可外聘）/ **协作中**（归属不变，见 §5）。一台壳同一时刻至多一个住户——「多身份一壳禁止」指**同时性**；换住户 = 解绑+新绑，时间不重叠。
3. `kind: agent` 必有 `identity.memory.ref`；探活失败**不删枝只亮黄灯**（记忆库搬家是监护人动作，不是系统自动行为）。
4. perms 三域互不相交，无继承。
5. manifest 写权（11-15 甜心定案）：**agent 可以改自己的任何字段（含 display_name）——修改推审批到人类对话，批了才落盘**。监护人/Portalk 核心直写。审批形状同 EP 审批卡：需人类决策才执行。
6. 分身/临时工不占成员文件（ID 契约已定：执行延伸不领身份证，索引键 task_id）。

## 5. 无主壳（Empty Shell）与外聘

- 甜心例：桌面上有个 Claude Code 但还没住户——它就是 Empty Shell，在有自己的住户之前，任何 agent 都可以通过工具面外聘它。
- **无主壳不挂成员文件**（无身份即无 slug），**挂在山海工具面下，和其他工具一样**——外聘=工具调用，走 task_id 台账，调用记录归调用者，不写任何记忆库。
- **外聘国法（11-15 甜心定案）：外聘 = 隔离 + spoor。**
  - **隔离**：外聘天生走全新 session（fresh 启动），不长私人残留——残留问题消失于源头。【工程】adapter caps 声明 isolation 能力，不支持隔离启动的壳不可被外聘（外聘面比有主面窄是设计使然）。
  - **spoor 记账**：外聘工作也进 spoor，Portalk 负责给外聘发 spoor 记账提醒（收工提醒，wander 班收尾笔记同款机制）。**落款落 runtime Shell 的名字**（如 `外聘·claude-code@wsl-main`）——劳动进账本、有签名，外聘不是管道。
- 有主壳也可以被协作借用（agent 间私聊直通，见下），归属不动、写权分账。
- 原「池文件」设计作废：不是单独一个 `_pool.yaml`，而是山海工具面的自然一部分——CLI 调用形状（很多壳本来就是走 CLI 的）。

## 5a. 工具面与山海归入（11-15 甜心定案 + 照照工程判断）

- **Portalk 不替 runtime 声明工具**：manifest 不存 caps 数组（已从 schema 删除）。Portalk 与山海同装，自带山海的能力声明面；能力查询 = adapter 直读 runtime 工具清单（机械事实）+ 山海条目（语义层）。
- **新增工具归入山海——三层分工**【照照判断·可推翻】（回应甜心之问：确定层还是声明面？答案是不二选一，各管一层）：
  - **存在归确定层**：adapter 在 session 建立时 diff runtime 工具清单，新增=机械事实，自动记对账事件——不依赖 agent 声明才被发现（agent 忘说/说错就漏账；probe 只报告不授身份的先例同款：机械源可信，声明源要审）。
  - **语义归声明面**：新工具的山海条目（它是什么、怎么用、坑在哪）由 agent 起草——它用这个工具，最懂。
  - **准入归人类**：agent 起草的条目走审批闸进山海正库（与 manifest 修改同款审批）。
- 一键归入山海的引导操作见 §6-4；日常增量归入走上面机制。

## 6. 第一个实例：出厂 Pianist 与新手引导（甜心 11-15 设定）

- 每份 Portalk 安装自带此成员：EP 包的空 Tideline + Moonshine，开箱即有——**一个 Emergence Pianist 空身份**。
- display_name 默认 Emergence Pianist，人类可改；slug/agent_id 是法律层不动。
- 它是「永远在线的默认身体」：未 pin 时消息的第一顺位（P2 接线的验收对象）。
- **新手引导（onboarding）**：user 选择进入引导 → Pianist 主动来找 user，做三件事——
  1. **帮 user 接上自己的 runtime**：对话式走壳探测协议的「开箱指引流程」（扫描→指纹匹配→导入卡片→claim 登记→manifest 自动生成）。卡片流程对话化，选择权仍在监护人（不点头不导入，协议原文不动）。
  2. **教 user 把 agent 全部部署进 Portalk**：每接一台壳，agent 可把 memory.ref 指到现有记忆库（挂载非拥有，Portalk 不复制），也可用随包空库从零长。
  3. **互相熟悉的小 talk → user 的初步 profile**：向导对话本身写进 Pianist 的空库（它的第一批记忆——空身份从向导开始长，不是从裸 API 开始）；user 的初步 profile 是 user 侧产物，经 user 确认后落 user 的 vault，manifest 挂引用（树是视图非存储——Pianist 对 user 的观察记 Pianist 的库，user 的 profile 归 user，各自归各自）。
  4. **一键归入山海**（11-15 甜心）：接壳时 runtime 已装的工具一键归入山海（配置过程）；此后 Portalk 交互中新增的工具按 §5a 机制增量归入。
- 数据面归 P0（manifest/profile 生成）；引导流程的交互面归 P2 前端；随包空库归 P4 打包。
- 上面的示例 YAML 即它的 manifest 雏形，路径按装机实况改。

## 7. 对 v0.1 文字树的改动清单

| v0.1 树 | v1 schema | 理由 |
|---|---|---|
| sessions/thread 枝 | **移除** | thread 表是正身（P1a），按成员查询即可——manifest 里再放一份就是双写 |
| 能力 → 山海挂载枝 | **不进 schema（11-15 定案）** | Portalk 不替 runtime 声明工具：能力面=山海声明面 + adapter 直读 runtime 工具清单（§5a）。manifest 存 caps=双写+二手声明 |
| shell/{provider} 单层 | `(provider, provider_ref)` 二元组 | 同类软件多实例（两台 hermes）要能区分 |
| 感官枝 | 保留为 senses[] 引用 | 不变 |
| 独立库 Diary/Opus | 保留为 vault 引用 | 不变 |

## 8. 待拍板（grill 清单）

- ~~Q1 壳归属语义~~ **已定案（11-15 甜心）**：壳三态——有主（挂 agent id，多壳共一库）/ 无主（挂山海工具面，任何 agent 可外聘）/ 协作中（归属不变，走 agent 间私聊，消息面与 thread 见 P1a 蓝图）。
- ~~Q2 外聘残留~~ **已定案（11-15 甜心）**：外聘 = 隔离 + spoor——fresh 启动隔离，残留消失于源头；外聘工作进 spoor，Portalk 发记账提醒，落款落 runtime Shell 名字（不清理不归档，没有残留可归）。不支持隔离启动的壳不可被外聘。
- ~~Q3 manifest 写权边界~~ **已定案（11-15 甜心）**：agent 可改自己任何字段（含 display_name），修改推审批到人类对话、批了才落。能力面=读 runtime 工具信息，非 agent 自报；Portalk 不替 runtime 声明工具（与山海同装自带能力声明面）；新增工具归入山海=存在归确定层、语义归声明面、准入归人类（§5a）。

**P0 grill 三问全清（11-15），schema 可定稿进施工。**
