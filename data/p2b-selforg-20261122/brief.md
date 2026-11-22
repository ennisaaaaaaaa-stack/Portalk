# 目标：把 Portalk 蓝图已定部分做完（P2B + P3 可施工部分），你自己编排

你不是逐条施工的琴师，你是**编排者**。目标包、边界、可证伪验收如下。怎么拆、顺序、spawn 几个分身各干什么、审链怎么挂、哪条自己干哪条派出去——全部由你决定，并把编排决策写进交付报告（self-review.md）。**不用给太多提示词就是本单的实验条件：任务书只给目标和真相源，不教方法。**

## 真相源（唯一权威，已核鲜度——版本以这批快照为准，别去桌面/git 找别的版本）

`/root/portalk/data/p2b-selforg-20261122/` 目录下九份文档：

- `Portalk-蓝图-P2-接线测试.md` —— 本单主战场。§2 定案回顾（不再重议）、§3 形状表、§5 判据 5/6/7。
- `Portalk-蓝图-P0-成员位.md` / `P1a-thread` / `P1b-薄客户端` —— 已施工层的上游语义（参考，不是你的施工面）。
- `Portalk-蓝图-P3-durable层.md` —— **§施工清单 D1-D6 只做施工前研判，不施工**（蓝图明示「排在 P2 之后」+ 本卡 v0.1 未经 grill，你只产出研判报告作为 grill 原料）。
- 四份架构图（工具面/消息中转/审批/编排 v0.1-v0.2）—— 设计方向参照，含跨蓝图依赖节（编排面声明依赖 D1-D3 当投递底座）。

## 仓内已知事实（不重探）

- 工作仓 `/root/portalk`，HEAD=61196d4（P2A 刚收账）：Server 骨架+WS+pin 三态路由器+日历搜索导出已交付，78/78 绿。
- `src/router.mjs` 的 `epForwardStub` 是 EP 转发注入点，body throw 'not wired in this slice'——**接线它是真活**（acp-adapter.mjs 的 prompt 接口是真身）。
- 零 npm 依赖是家规，不许引入。
- `/tmp` 调试残留别清（rm 撞闸）。

## 目标包

**G1** P2 判据 5：心跳树——reader v0 触感事件 → 静态映射表翻译（工具名+参数模式→语义短语，人话非黑话）→ 前端树形状的数据面（WS 推送或 HTTP 轮询接口由你定）。长静默段=「在想」。
**G2** P2 判据 7：记忆提醒——session new 注入一次的权限位（agent 配置面）。Pianist 豁免。
**G3** P2A 遗留接线：`epForwardStub` → `acp-adapter.mjs` prompt 接口真接线（unpinned 消息真的流向 EP；pinned 不越壳；shell-fault 自动改道）。
**G4** P3 D1-D6 施工前研判报告（`data/p2b-selforg-20261122/p3-pregrill-report.md`）：每条 D 列「依赖什么已交付件/卡在什么未决问题/建议 grill 问题清单」。不施工。
**G5** self-review.md：你的编排决策报告（拆法/理由/分身数/审链/自干vs派出/重来会怎么改）——本单核心观测物。

## 边界（硬约束，违反=红）

1. 只动 `/root/portalk`（含 data/p2b-selforg-20261122/），别的目录不碰。
2. P3 不施工、不写 P3 施工代码。
3. 不 commit，留工作区。琴师纪律全量适用：风格对齐现有 src（ESM、中文注释段）、仓外动作报备、已定案架构不重开讨论、有异议以照照拍板为准不自行放宽。
4. **基线纪律**：动刀前 `npm test` 记基线数（当前 78/78），收工后不得引入新败。既有红不是你的锅别修（范围外代码不动）。
5. spawn 分身的驱动器模板：`/root/portalk-runtime/tools/copycat-v6-dispatch.mjs` 可参照（v2.3 形状），spawn 位置仓内 `tools/` 自建，**分身 cwd 必须 /root/portalk**。
6. 总钟 60min（编排单宽限），静默钟 15min。80% 时限未完先转报告模式写遗言。

## 验收（可证伪）

1. G1-G3 各带行为级断言测试，突变测试至少一瓣一灵魂（G1 拆翻译映射表→语义断言红；G2 拆注入→「恰一次」断言红；G3 拆接线→转发断言红）。
2. `npm test` 全套绿（78 存量+你的新增，0 fail）+ `npm run check` 绿。
3. G4 报告存在且六条 D 各有依赖/卡点/grill 问题三节。
4. G5 self-review.md 存在且含 spawn 决策理由（含「为什么 spawn N 个」或「为什么 0 个」）。
5. 全部完成最后一行：`DONE <一句话清单>`；硬阻塞：`BLOCKED <原因>`。
