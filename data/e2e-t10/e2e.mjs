// T10 真身端到端：真 pi 引擎过 compose 栈跑消息闭环（三类消息+回话回流）
// 判据：unpinned 消息→EP 真身 spawn→agent 回话落库+WS 可见；pinned 不越壳
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { openDb } = await import(path.join(ROOT, 'src/db.mjs'));
const { createThread } = await import(path.join(ROOT, 'src/threads.mjs'));
const { createPortalkStack } = await import(path.join(ROOT, 'src/compose.mjs'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-e2e-'));
const db = openDb(path.join(tmp, 'e2e.db'));
const U = 'p:u-0001';

const stack = await createPortalkStack({
  db,
  host: '127.0.0.1',
  port: 0,
  membersDir: path.join(ROOT, 'members'),
  piCommand: '/root/portalk-runtime/node_modules/.bin/pi',
  piBaseArgs: ['-p', '--model', 'zai-coding-cn/glm-5.2'],
  cwd: '/root/portalk',
  env: { ...process.env, no_proxy: '127.0.0.1,localhost', NO_PROXY: '127.0.0.1,localhost', NO_COLOR: '1', PIANIST_AGENT_ID: 'pianist-dev-2', PIANIST_SHELL_URL: 'http://127.0.0.1:8770' },
  memoryRemind: false,
  telemetryDir: '/root/portalk-runtime/data/telemetry',
});
const started = await stack.start();
const base = `http://127.0.0.1:${started.port}`;
console.log('server up:', base, 'tree nodes:', Object.keys(stack.tree.snapshot?.() ?? {}).length);

// 1) HTTP health + thread 建立
const th = createThread(db, { type: 'topic', title: 'T10 真身端到端', createdBy: U, memberIds: [U] });
console.log('thread:', th.id);

// 2) WS 连上窗口
const { wsConnect, nextOfType, collectEvents } = await import(path.join(ROOT, 'test/ws-client.mjs'));
const ws = await wsConnect(started.port, `/threads/${th.id}`);
console.log('ws ready, lastSeq=', ws.ready?.lastSeq);

// 3) 三类消息里的 human 类：真身 unpinned 转发（WS 发=走 routeMessage→epForward 真身）
const t0 = Date.now();
await ws.send({ type: 'message', threadId: th.id, sessionId: 'e2e:s1', speakerId: U, role: 'user', content: '请只回一句话：T10 收到。不要做任何其他事。' });
console.log('user msg sent, waiting EP spawn...');

// 4) 等 agent 回话回流（WS 收 type=message 且 speaker=agent；真身 spawn 给 300s）
let agentReply = null, treeSaw = false;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline && !agentReply) {
  try { await ws.next(5000); } catch { /* 队列空继续等 */ }
  for (const e of ws.log) {
    if (e.type === 'tree' && !treeSaw) { treeSaw = true; }
    if (e.type === 'message' && (e.speaker_id ?? e.speakerId) !== U && (e.role ?? '') !== 'system') agentReply = agentReply ?? e;
  }
}
console.log('agentReply:', agentReply ? JSON.stringify({ speaker: agentReply.speaker_id ?? agentReply.speakerId, role: agentReply.role, content: String(agentReply.content).slice(0, 120) }) : 'TIMEOUT');
console.log('treeSaw(event pushed):', treeSaw, '| tree snapshot:', JSON.stringify(stack.tree.snapshot?.() ?? null).slice(0, 200));

// 5) 库侧核对：agent 回话真落库
const msgs = (await import(path.join(ROOT, 'src/threads.mjs'))).listThreadMessages(db, th.id);
console.log('db messages:', msgs.map((m) => `${m.role}/${m.speaker_id}: ${String(m.content).slice(0, 40)}`));

// 6) pinned 不越壳
await ws.send({ type: 'message', threadId: th.id, sessionId: 'e2e:s1', speakerId: U, role: 'user', pinState: 'pinned', content: 'pin 住的测试消息，EP 不该收到' });
await new Promise((r) => setTimeout(r, 8000));
const fwd = stack.epForward.stats;
console.log('epForward stats:', JSON.stringify(fwd));

// 7) HTTP 搜索（判据 6 顺手）。注：探针词必须存在于消息正文——搜索吃 m.content 不吃 thread 标题；
//    11-22 首版用「真身」查得 0 命中，根因即词只在标题「T10 真身端到端」里，非端点病（wander 11-22 四班 SQL 复核）。
const searchTerm = '收到'; // 三条消息正文全含（user 提示/agent 回话/pinned 都带「收到」）
const sr = await fetch(`${base}/api/search?q=${encodeURIComponent(searchTerm)}`).then((r) => r.json());
const searchCount = sr.count ?? sr.results?.length ?? -1;
console.log('search hits:', searchCount, '(term:', searchTerm + ')');

ws.close?.();
await stack.close();
const pass = agentReply && fwd.forwarded >= 1 && searchCount >= 1;
console.log('T10 verdict:', agentReply && fwd.forwarded >= 1 ? 'PASS' : 'FAIL', `(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
fs.rmSync(tmp, { recursive: true, force: true }); // mkdtemp 拆库不留坟（11-22 首版漏收，/tmp 沉四座）
process.exit(pass ? 0 : 1);
