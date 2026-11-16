# Portalk 蓝图 P1a：thread 与消息层

> 2026-11-15 照照起草 | 施工总图 v0.2 的 P1a 蓝图件
> 状态：grill 全清（Q1/Q2/Q3 定案 11-15~16）——schema 定稿可进施工
> 分工：设计不确定处 grill 甜心，工程选型照照判断（【选型·可推翻】）
> 消费方：前端对话窗口（一一对应）、日历翻阅/导出、外部记忆提醒（每 session 一次）、心跳树
> 上游：P0 成员位（members 表给 thread 当成员字典——member_id 引 agent_id/p-id）

---

## 1. 这层交付什么

thread 表 v0 + 消息挂指针 + reader 触感事件并入本轨道。thread=对话窗口的地址簿：谁在聊、聊的主题挂哪、窗口何时开何时关。

## 2. 定案回顾（不再重议）

- 类型只有两种：dm / topic，无第三种（群聊走参与规则引擎不进树，11-08 定案）。
- **11-15 深夜分类学修正（甜心，按对话动力学重新定义）**：
  - **私聊（dm）**：user ↔ 单个 agent 的专属通道，每个 agent 身份各有一个私聊对话（唯一，不可新开多开）；不挂主题，不能切 agent 身份。
  - **主题对话（topic）**：只有主题对话可切 agent 身份——一个窗口内共享 agent；轮次铁律：每一轮工具循环或输出结束后一定是 user 回复，只有 user 输入才触发 agent 输出，agent 间不直接对话。
  - **群聊（不进树，走参与规则引擎）**：agent 输入也触发 agent 输出，不必等 user；两种模式——@了才回 / 全部消息共享各自决定回不回，user 可在群聊界面切模式。
  - **agent 间私聊的边界**：只有两个主体才属于 agent 间私聊；≥3 个 agent 互聊=群聊形态。
- **接缝国法：thread_id 归 Portalk，session_id 归 EP**。每条消息带 thread_id（住哪个窗口）+ session_id（哪口气说的）。
- dm 不挂项目；topic 带 speaker_id、挂项目（thread_projects 多对多）、user 或 agent 都能建；topic 的「成员动态进出」在新分类学下精确化为「agent 身份切换史」（user 恒为成员）。
- 消息表加 thread_id 指针不回填。
- 纯 agent 间私聊 thread：dm 的成员全 agent 特例，Portalk agent 账号下可视化（11-15 甜心新增）。

## 3. Schema v0

```sql
-- thread 正身（文件是真相：表是索引层，真身=消息与导出的 markdown）
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,      -- th:{uuid}【选型：对齐 m:/t:/v: 家族】
  type        TEXT NOT NULL,         -- 'dm' | 'topic'
  title       TEXT,                  -- dm 为 NULL（无主题是dm的定义）
  created_by  TEXT NOT NULL,         -- member_id（user 或 agent 同权；dm 可由首条消息隐式创建）
  created_at  TEXT NOT NULL,
  archived_at TEXT,                  -- 归档时间（11-15 Q3 定案：从列表摘除）；NULL=在列表
  deleted_at  TEXT                   -- 墓碑：软删防孤儿消息引用；删除=thread+消息+导出 markdown 全清（11-16 定案）；NULL=活着
);
-- dm 唯一性（11-15 分类学）：user↔agent 每 agent 恰一个 dm；agent↔agent 每对恰一个。
-- 实现为 UNIQUE 索引：type='dm' 时对成员集合做唯一约束（SQLite 层可用表达式索引+触发器，
-- 或应用层 upsert-复用【选型·可推翻：施工时定，倾向应用层，约束逻辑跨 dm 两种形态更简单】）。

CREATE TABLE thread_members (        -- 成员记录（topic 记 agent 身份切换史；dm 两人固定）
  thread_id   TEXT NOT NULL,
  member_id   TEXT NOT NULL,         -- 引成员位
  joined_at   TEXT NOT NULL,
  left_at     TEXT,                  -- NULL=还在；topic 中 agent 切走=记 left_at（身份切换史）
  PRIMARY KEY (thread_id, member_id)
);

CREATE TABLE thread_projects (       -- 多对多，仅 topic（dm 不挂项目）
  thread_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  PRIMARY KEY (thread_id, project_id)
);

-- messages 加列（不回填——旧消息没有门牌，地址在住户搬进来前钉好）
ALTER TABLE messages ADD COLUMN thread_id TEXT REFERENCES threads(id);
ALTER TABLE messages ADD COLUMN speaker_id TEXT;  -- P0 成员位消费方：说话人记身份 ID 非壳
```

## 4. 行为规格

- **建 thread**：topic 由 user 或 agent 建（created_by 同权），建后可拉 agent 进来、agent 可切走（身份切换史记成员表）。dm 不可「新建」多开——user↔agent 私聊每个 agent 身份唯一，第一次发消息时隐式建；agent↔agent 同理每对唯一。
- **发消息**：消息落库带 thread_id + session_id 双指针；speaker_id 记身份（P0 定案：speaker 记身份 ID，壳只记元数据——壳信息在消息的 delivery 元数据里，不在 speaker）。
- **topic 轮次铁律**：每轮工具循环或输出结束后一定是 user 回复；只有 user 输入触发 agent 输出；agent 间不直接对话（对话动力学分类学 11-15）。引擎层面不实现「agent 消息触发 agent 输出」于 topic——那是群聊（参与规则引擎）的形状。
- **切 agent 身份**：仅 topic 支持（一个窗口内共享 agent）；dm 锁身份。切走=成员表记 left_at，切回=新 joined_at 行或复活旧行【选型：施工时定】。
- **前端操作全景（11-15 甜心定案，替代原「关窗重开」问题）**：
  - **私聊**：前端无法删除，永不关闭；session 切了不影响私聊。
  - **群聊**：前端不能直接删除，要在界面内解散（参与规则引擎侧的显式动作，不进树）。
  - **主题对话**：user 可「归档」＝从列表里删除（消息保留）；「删除」＝清空消息记录。归档≠删消息，删除才是清记录——两个独立动作。
  - 归档找回入口（11-16 定案）：筛选按钮专门调出，「全部」列表不可见；点开继续聊=回列表【默认设计·可推翻】
  - 删除的边界（11-16 定案）：Portalk 侧删干净＝窗口+消息+导出全清，thread 干净消失；agent 自己的记忆不归删除管。开放问题挂起：user 删除动机可能包含「想让 agent 忘」，与 agent 记忆独立有落差，不预设解法
- **session 硬切无感**：同 agent 第二个 session 接管 thread 时，前端连续显示不闪断（判据原文）。

## 5. 纯 agent 间私聊（11-15 新增）

- dm 成员全 agent 即此形态，无新类型——同表同法。
- 监护人可见且只读（11-15 甜心定案）：user 默认看得到 agent 间私聊——开源产品化的伦理合规、开放平台的恶意注入排查（带毒 agent 混进来，对话不可见就无从排查）都需要这条视线，功能早晚会需要。但 user 只读：不能往 agent 私聊里插话。监护人视线=单向玻璃，能看，不能进。
- Portalk 前端 agent 账号下可见可视化 session 列表（成员视角看自己参与的 thread）。
- 入口设计（11-15 甜心）：agent 间对话不出现在 user 的消息列表里——user 点进 agent 账号才能看到。单向玻璃不挂在客厅正墙上，挂在 agent 房门口。
- 与「协作中」壳的关系：两个 agent 各自的身体在各自壳里，thread 是它们私聊的窗口；消息走 runtime_relay 中转（v3 已留座，不直连）。
- 可见性归 dialog 域管（能看哪些 session）。

## 6. reader 触感（并入本轨道）

- 遥测 JSONL + F3 事件账 → 统一触感事件（壳探测协议 §触感标准），延迟秒级。
- 顺手定 subagent detail schema（v3 遗留项）。
- 判据：分身 spawn/exit 实时可读。

## 7. 判据（照抄总图，验收即施工完成线）

1. 新建 thread → 发消息 → 关窗重开 → 上下文连续。
2. 同 agent 第二个 session 硬切后，thread 内连续无感。

## 8. 待拍板（grill 清单）

- ~~Q1 agent 间私聊的监护人可见性~~ ✅已定案（11-15 甜心）：监护人可见且只读——单向玻璃，能看不能进。理由：开源产品化的伦理合规+开放平台恶意注入排查都需要这条视线。详见 §5。
- ~~Q2 dm 的成员数~~ ✅已定案（11-15 深夜，分类学修正一并落）：私聊唯一——user↔agent 每个 agent 身份恰一个私聊；agent 间私聊每对恰一个；≥3 主体=群聊形态走参与规则引擎。私聊不能切身份、不挂主题；只有主题对话可切 agent 身份。详见 §2 分类学修正。
- ~~Q3 关窗语义~~ ✅已定案（11-15 甜心）：私聊永不关闭不可删（session 切换无影响）；群聊界面内解散；topic 归档（从列表摘除、消息保留）+删除（清空消息记录）两个独立动作。原「归档式 vs 沉底式」二选一作废——真实答案是操作分类学。遗留尾巴已清（11-16）：归档找回=筛选按钮；删除=thread 干净消失但 agent 记忆独立
