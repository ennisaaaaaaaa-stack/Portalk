# 施工报告：Portalk P0 成员位 + P1a thread 层（新仓首单）

> 施工：pianist（琴师分身）· 2026-11-16 · 蓝图：`docs/blueprints/Portalk-蓝图-P0-成员位.md`（11-15 定案）+ `Portalk-蓝图-P1a-thread.md`（11-15/16 定案）
> 状态：完工待复验。**未 commit**（按纪律留工作区）。零 npm 依赖（纯 Node 22 内置模块）。

---

## 1. 交付物清单

| 文件 | 内容 |
|---|---|
| `members/schema.json` | P0 §3 schema v1（含权限路径语法 v1 的 pattern 落码） |
| `members/pianist.yaml` | 出厂第一实例（路径按 `/root/portalk` 实况） |
| `src/yaml.mjs` | 极简 YAML 子集解析器（自写，零依赖约束） |
| `src/jsonschema.mjs` | 自写 JSON Schema 校验器（required/type/enum/pattern/uniqueItems/items/properties/minItems） |
| `src/loader.mjs` | manifest 载入器 + §4 不变量强制 + 黄灯错误对象 |
| `src/db.mjs` | node:sqlite 建库（P1a §3 SQL）+ 路径解析（--db > PORTALK_DB > data/portalk.db） |
| `src/threads.mjs` | thread 行为层（P1a §4） |
| `bin/portalk.mjs` | 最小 CLI（建库 + 成员位载入亮黄灯） |
| `package.json` | name/bin/scripts（test= node --test / check / fixtures） |
| `test/` | 7 文件 46 测：fixtures.mjs（可重置生成器）、gen-fixtures.mjs（CLI）、yaml/jsonschema/loader/db/threads `.test.mjs` |
| `REPORT.md` | 本件 |

## 2. 蓝图条目 → 文件 → 测试对照表

### P0 成员位

| 蓝图条目 | 落点 | 测试 |
|---|---|---|
| §2 格式：YAML 一成员一文件 `members/{slug}.yaml`，文件是真相 | loader 按此发现+校验文件名=slug | loader.test「不变量违者拒载」slug-file-mismatch 项 |
| §2 校验：JSON Schema 版本化，坏了亮黄灯拒载不静默 | `members/schema.json` + `src/jsonschema.mjs` + loader 错误对象（stage/schema/messages） | loader.test「schema 坏件拒载出声，好件照载」四阴控 + formatErrors 断言 |
| §3 字段：manifest_version/slug/kind/agent_id/display_name/identity.memory(ref+liveness)/shells[]（mount/provider/provider_ref/claim_bound_at/claim_bound_by/address）/perms 三域/senses[]/vault | schema.json properties 逐字段（pattern 落码：slug 小写、agent_id `a:|p:` 前缀、ref `协议://`、liveness enum ['file']、日期形状、权限路径 `域:对象类型[:对象]`） | jsonschema.test 七组关键字直测 + loader 全链阴控 |
| §3 权限路径 v1 只定前两段 | perms 各域 items pattern `^[a-z][a-z0-9_-]*(:…)+$`（至少两段） | schema 链路阴控（bad-pattern） |
| §3 无 caps 字段（11-15 定案不替 runtime 声明工具） | schema 无此字段；pianist.yaml 注释指 §5a | jsonschema.test「本体只声明受支持关键字」防漂移 |
| §4-1 slug 全局唯一、agent_id↔slug 1:1 | loader checkInvariants | loader.test dup-slug / dup-agent-id 项 |
| §4-2 壳三态：同壳至多一住户，换住户时间不重叠 | loader 按 (provider, provider_ref) 分组查 claim 窗口重叠 + 同件 mount 名/壳不重复 | loader.test claim-overlap / mount-dup /「时间窗翻转」/「开放窗口叠加」 |
| §4-3 kind=agent 必有 identity.memory.ref（探活归 conductor 运行时） | loader 强制 presence；探活不做（见 §4 偏离-8） | loader.test agent-no-memory 项 + 好件目录 human 枝空照载 |
| §4-4 perms 三域互不相交、无继承 | loader：同一路径不得出现在两域 | loader.test perms-overlap 项 |
| §4-5 写权推审批 | 运行时行为（conductor），本单不做审批面（任务单明示） | — |
| §4-6 分身不占成员文件 | 政策约束，无可检结构（manifest 无临时工字段） | — |
| §6 出厂 Pianist：随包空库形状、display_name 归人类、永远在线默认身体 | `members/pianist.yaml`（memory.ref→`data/tideline/`、senses→仓内 `senses/moonshine/`、address=`systemd:portalk-conductor`） | yaml.test 全形状解析 + loader.test「出厂 members/ 全绿入树」 |

### P1a thread 层

| 蓝图条目 | 落点 | 测试 |
|---|---|---|
| §3 threads 表（th:{uuid}/type/title(dm NULL)/created_by/created_at/archived_at/deleted_at 墓碑） | db.mjs SQL 照抄（列注释语义进注释） | db.test「threads 列语义」 |
| §3 dm 唯一性 UNIQUE——【选型】应用层 upsert-复用 | threads.mjs `createThread` 复用 + `findDmByMembers`（含唯一性破损防线） | threads.test dm user↔agent / agent↔agent 恰一+复用（成员序无关） |
| §3 thread_members（身份切换史；PK 一人一行） | db.mjs 照抄；join/leave/switchAgent 行为 | threads.test「切 agent 身份」 |
| §3 thread_projects 多对多仅 topic | db.mjs 照抄；createThread：dm 挂项目拒收 | threads.test topic 挂两项目 / dm 不挂项目 |
| §3 messages 加列不回填 | 新库首建 CREATE（见偏离-2），thread_id REFERENCES + speaker_id | db.test「messages 挂双指针列」+ FK 阴控 |
| §4 建 thread：topic user/agent 同权可建、可拉人、可切走 | createThread/joinThread/leaveThread/switchAgent | threads.test「topic 切 agent 身份」「拉 B 进来」 |
| §4 dm 不可新建多开、首条消息隐式建 | 复用语义即隐式建的引擎侧接口（P2 调 createThread） | dm 复用两测 |
| §4 发消息双指针 + speaker 记身份 | appendMessage 落库 thread_id+session_id+speaker_id | threads.test「形状校验」 |
| §4 轮次铁律归引擎层 P2，本层不推断 | appendMessage 只做形状校验（thread 存在/成员在册未切走/role 枚举/双指针必填） | threads.test「连续 agent 消息照收」（回归护栏，防私做轮次推断） |
| §4 归档=从列表摘除消息保留（≠删除） | archiveThread/unarchiveThread + listThreads 默认滤除、`{includeArchived:true}` 调出 | threads.test「归档」 |
| §4 删除=thread+消息+导出 markdown 全清，一个口 | `purgeThread()`（消息行+导出文件+threads 行+挂表行） | threads.test「purgeThread 全清」 |
| §4 私聊永不关闭/前端不可删 | purgeThread 默认拒 dm，需显式 force | threads.test「dm 前端不可删」 |
| §4 归档找回=筛选按钮（11-16） | listThreads includeArchived 参数即筛选面数据接口 | threads.test「归档」 |
| §2 分类学：dm 恰两人、≥3=群聊不进树 | createThread dm 人数校验拒 3 人 | threads.test「恰两人」 |
| §5 纯 agent 间私聊同表同法 | dm 成员全 agent 无特判（findDmByMembers 同一查询） | threads.test「agent↔agent 恰一」 |
| §7 判据（关窗重开上下文连续/硬切无感） | 前端+引擎层验收（P2），本层保证：消息挂 thread_id 恒存、dm 复用恒同 id | 上述测试为其地基 |

### 任务单附加件

| 要求 | 落点 | 测试 |
|---|---|---|
| 坏件亮黄灯拒载不 crash，整套继续 | loader 逐文件 try/catch，错误对象带 stage/messages | 三个坏件目录 × 好件照载断言 |
| 夹具可重置（删目录重跑即重建） | fixtures.mjs `ensureFixtures`（幂等清建）+ gen-fixtures.mjs CLI；testdata/ 已 gitignore | 测试每跑必重建；`mv test/testdata /tmp` 后 gen-fixtures 重建再全绿（已演示） |
| db 路径 CLI/env/缺省 | resolveDbPath(--db > --db= > PORTALK_DB > data/portalk.db) | db.test 优先级四断言 |
| 阴性对照亲手掰 | 见 §5 验收清单 | loader.test「阴性对照·删必字段」/ threads.test「purgeThread 行不在」/ loader.test「时间窗翻转」 |

## 3. 偏离蓝图处（逐条，均已在代码注释标注）

1. **schema 增可选字段 `claim_released_at`**（蓝图 §3 示例六字段之外）：§4-2「换住户=解绑+新绑，时间不重叠」若无解绑时间则窗口无下界、任何换住户都判重叠，校验不可实现。不写=开放窗口（仍在住），与示例形状兼容。
2. **messages 表用 CREATE 而非蓝图原文的 ALTER TABLE**：蓝图面向既有 messages 表加列；本仓新库首建，指针列直接落进 CREATE。语义同「加列不回填」，db.mjs 注释保留原形说明。
3. **SQL 加挂 `IF NOT EXISTS`**：幂等开库（同路径二次 open 不炸），其余逐字照抄。
4. **purgeThread 连 thread_members/thread_projects 挂表行一起清**：任务单列的是消息+导出+threads 行；挂表行不清会留孤儿引用——恰是蓝图 deleted_at 注释要防的孤儿。全清经同一个口。
5. **dm 的 purge 默认拒、需 `{force:true}`**：蓝图「私聊前端无法删除，永不关闭」。系统级维护口保留但须显式，防 P2 前端误用。
6. **切回选型落定=复活旧行**（蓝图【选型：施工时定】二选一）：PK (thread_id, member_id) 结构上禁止同人第二行，故切回=清 left_at + joined_at 更新为回归时间；代价见坑-3。
7. **`.gitignore` +3 行**（`test/testdata/`）：挡测试生成物。本单唯一改动的既有文件。
8. **探活（liveness=file 的实际开库探测）不做**：ref 是协议地址（tideline://），解析协议到文件系统是 adapter 层事；本层只验形状。§4-3 的「探活失败不删枝只亮黄灯」是 conductor 运行时行为。
9. **agent_id 对 human 用 `p:` 前缀且 required**：蓝图示例 `claim_bound_by: p:tianxin` 已含人类身份形；字段名单一维持人机同构（人类的 identity 枝空=事实稀疏，agent_id 不空）。

除上述工程适配外无偏离；schema/SQL/行为规格均按蓝图字面。

## 4. 新发现坑（已入 spoor portalk 项目坑账）

1. **node 22 的 `node --test` 不吃目录参数**：`node --test test/` 把目录当模块加载报 MODULE_NOT_FOUND；须 `node --test test/*.test.mjs`（package.json 已按此）。
2. **node:sqlite 每连接须 `PRAGMA foreign_keys=ON`**，否则 REFERENCES 静默不生效；且 node 22 每次连接打 ExperimentalWarning（stderr 噪声，非故障）。
3. **thread_members PK 一人一行 → 身份切换史只留最近一段**：多次切走/切回的完整历史 v0 schema 表达不了（蓝图选型已预告二选一，PK 结构裁定复活旧行）。要记全史需 join/leave 事件表——P2 引擎层真实需求出现再扩，不预支。
4. **YAML 子集须收紧键名形状**（只允许字母开头标识符）：否则 `::::` 这类垃圾解析成 `{':::': null}` 拖到 schema 段报「缺必填字段」，误导排查。收紧后垃圾在 parse 段就带行号黄灯。
5. **perms「三域互不相交」的可执行解读**：同一路径串不得出现在两域（loader 强制）；域前缀不强制——蓝图例 `group:symposion` 按语境可住在 interact 域，硬性前缀=域段语义会与之矛盾。「无继承」是判读语义（无跨域通配级联），载入层无可检结构，以注释落码。
6. **dm 归档后复用不自动回列表**：createThread 复用在册 dm 原样返回（含已归档）；归档找回走显式 unarchiveThread（筛选按钮语义），避免「复用」顺手改档案状态。

## 5. 验收自检（按施工单清单）

1. ✅ `node --test test/*.test.mjs` 全套两遍绿：46/46 × 2（夹具重置演示后再两遍绿）
2. ✅ 阴性对照亲手掰：
   - 删 schema 必字段（perms）→ 拒载出声：loader.test「阴性对照·删必字段」+ missing-perms 夹具
   - 删 threads 行 → purgeThread 报错不静默：threads.test「thread 行不在=报错不静默」
   - 改夹具时间 → 判定翻转：loader.test「时间窗翻转」（claim 11-06=合法换住户入树 ↔ 11-03=重叠拒载）
3. ✅ `node --check` 全部 .mjs（src×5 + bin×1 + test×7）
4. ✅ 本 REPORT §2 对照表逐条对上蓝图 §3/§4
5. ✅ `git status`：新增 `bin/ members/ src/ test/ package.json REPORT.md` + `.gitignore` 改 3 行（§3-7 已报备），无其他越界改动

## 6. 跑过的命令清单

```bash
node --check src/yaml.mjs src/jsonschema.mjs src/loader.mjs src/db.mjs src/threads.mjs bin/portalk.mjs test/*.mjs   # 全过
node --test test/*.test.mjs                    # 多轮，终态两遍 46/46 绿
npm test                                       # 绿（scripts.test 同链路）
node bin/portalk.mjs --db /tmp/portalk-cli-demo/portalk.db                    # 绿路：db ready + pianist 入树
node bin/portalk.mjs --db /tmp/portalk-cli-demo/portalk.db --members test/testdata/members-bad-yaml   # 黄灯演示：3 parse 拒载、好件照载、exitCode 1
node test/gen-fixtures.mjs                     # 夹具重建
mv test/testdata /tmp/portalk-testdata-aside && node test/gen-fixtures.mjs && node --test test/*.test.mjs   # 夹具重置演示（rm -rf 上浮审批后换 mv 非破坏等效）
git status --short && git diff --stat          # 越界检查
```

仓外动作报备：① spoor portalk 项目入账两笔（施工判断 + 坑账四条，runtime 记忆层）；② `/tmp` 下 CLI/测试临时目录（照单归照照清）。其余为零。
