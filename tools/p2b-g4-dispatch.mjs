// tools/p2b-g4-dispatch.mjs —— P2B 编排单的分身驱动器（G4：P3 施工前研判报告）
// 形状参照 copycat-v6-dispatch（v2.3 驱动器）：buildRuntime + launchMinion + 交货单收口。
// 本单实验条件：任务书只给目标和真相源不教方法——分身同样只给目标包与真相源。
// 分身 cwd=/root/portalk（任务书硬约束）；runtime 台账全部注入仓外（不污染工作仓）。
import { buildRuntime } from '/root/portalk-runtime/src/orchestrator/runtime.mjs';
import fs from 'node:fs';

const T = { id: 'p2b-g4-pregrill' };

const sheet = `# ${T.id} P3 施工前研判报告

任务：${T.id} P3 durable 层施工前研判报告（只写报告，不施工）

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 25 分钟

背景与边界：
工作仓 /root/portalk（你的 cwd，产出只进这里）。Portalk=多 agent 桌面通信中枢：P0 成员位/P1a thread/P1b ACP 薄客户端/P2A Server 骨架已交付（HEAD=61196d4，78/78 绿）。
P3（durable 层：持久执行与跨机工具调用）蓝图排在 P2 之后、v0.1 未经 grill——本单【不施工不写代码】，只产出施工前研判报告，作为后续 grill 的原料。

真相源（唯一权威，全在 /root/portalk/data/p2b-selforg-20261122/，版本以此为准别去桌面/git 找别的版本）：
- Portalk-蓝图-P3-durable层.md（主战场：四个决策 + D1-D6 施工清单 + 跨蓝图依赖节）
- Portalk-蓝图-P2-接线测试.md（P2 判据与接线面——D 们的上游）
- Portalk-蓝图-P0-成员位.md / P1a-thread / P1b-薄客户端（已施工层语义）
- Portalk-架构-工具面.md / 消息中转.md / 审批.md / 编排.md（设计方向参照；编排面声明依赖 D1-D3 当投递底座）
仓内实况（研判依赖时读实码）：/root/portalk/src/（router/server/acp-adapter/reader/threads/loader/db）、members/、test/

交付物清单：
- /root/portalk/data/p2b-selforg-20261122/p3-pregrill-report.md（唯一交付物）

验收标准：
- 六条 D（D1-D6）每条恰有三节：依赖（点名具体文件/接口+是否已满足）/ 卡点（未决问题逐条）/ grill 问题清单（每条 D ≥3 问，问能改变设计走向的真问题不问核对题）
- 报告头部有总述：施工顺序建议+哪条最危险+为什么
- 依赖与卡点必须对照仓内实码（src/ 实况）而非只抄蓝图——评审员会抽查
- 中文，工程判断语气；仓内除交付物外零改动

纪律：
- 只读代码与蓝图；除交付物本身外不写不改仓内任何文件
- 不 commit
- 卡死最后一行 BLOCKED:环境: <原因>；完成最后一行 DONE <一句话清单>
`;

const rt = buildRuntime({
	sheetText: sheet,
	cwd: '/root/portalk',
	shellUrl: 'http://127.0.0.1:8770',
	telemetryDir: '/tmp/p2b-g4-orch/telemetry',
	eventsDir: '/tmp/p2b-g4-orch/events',
	progressDir: '/tmp/p2b-g4-orch/progress',
});

rt.startLoop(2000);
const rec = rt.launchMinion({ taskId: T.id, role: 'worker pianist' });
console.log(`spawn: ${rec.minionId} pid=${rec.pid}`);

const t0 = Date.now();
const TIMEOUT = 26 * 60 * 1000; // 预算 25min + 收口余量 1min
await new Promise((resolve) => {
	const iv = setInterval(() => {
		const msgs = rt.inbox.peekAll();
		const deliveries = msgs.filter((m) => m.kind === '交货单');
		const bad = msgs.filter((m) => m.kind === '讣告' || (m.kind === '通知' && String(m.text ?? '').includes('发车失败')));
		if (deliveries.length >= 2 || bad.length > 0 || Date.now() - t0 > TIMEOUT) {
			clearInterval(iv);
			resolve();
		}
	}, 5000);
});
await new Promise((r) => setTimeout(r, 30 * 1000));
rt.stop();

const msgs = rt.inbox.peekAll();
const deliveries = msgs.filter((m) => m.kind === '交货单');
const verdict = deliveries.find((m) => String(m.minionId ?? '').includes('-审-'))?.manifest?.verdict ?? null;
console.log(`${T.id} 收口: ${Math.round((Date.now() - t0) / 60000)}min 交货${deliveries.length} verdict=${verdict}`);
fs.writeFileSync('/tmp/p2b-g4-inbox.json', JSON.stringify(msgs, null, 1));
process.exit(0);
