#!/usr/bin/env node
// bin/portalk.mjs —— CLI 入口
//   portalk [--db PATH] [--members DIR]                 建库 + 成员位载入亮黄灯（首单行为不变）
//   portalk serve [--port 9200] [--db PATH]
//                [--host 127.0.0.1] [--export-dir data/exports]
//                                                      P2 接线层：HTTP API 面 + WebSocket 长连面
//   portalk acp demo --task "..." [--thread th:uuid]    P1b 全链演示：dm 建连→prompt→事件流打印→审批卡浮出→close
//                                                      （acp demo 可真链：spawn 真 pi 一次，本单唯一真钱点）
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDbPath } from '../src/db.mjs';
import { loadMembers, formatErrors, DEFAULT_MEMBERS_DIR } from '../src/loader.mjs';
import { listThreadMessages } from '../src/threads.mjs';
import { createAcpAdapter } from '../src/acp-adapter.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const argv = process.argv.slice(2);

const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(name);

// —— pi 可执行解析：env PORTALK_PI_BIN > 仓内 node_modules > 本机 runtime 装配位 > PATH 的 pi ——
function resolvePiBin(explicit) {
  if (explicit) return explicit;
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', '.bin', 'pi'),
    '/root/portalk-runtime/node_modules/.bin/pi', // 本机装配位（Pianist runtime 与 Portalk 同机）
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'pi';
}

// ---------------------------------------------------------------------------
// acp demo —— P1b 全链演示
// ---------------------------------------------------------------------------
async function acpDemo() {
  const task = flagValue('--task');
  if (!task) {
    console.error('用法：portalk acp demo --task "..." [--thread th:uuid] [--db PATH] [--members DIR] [--model M] [--pi-bin PATH] [--approval-wait MS]');
    process.exitCode = 2;
    return;
  }

  // 真链护栏：等子进程退场的总超时（缺省 5 分钟，LLM 慢轮不误杀，挂死不拖死 demo）
  const waitTimeoutMs = Number(flagValue('--wait-timeout') ?? 300_000);

  const dbPath = resolveDbPath();
  const membersDir = flagValue('--members') ?? DEFAULT_MEMBERS_DIR;
  const db = openDb(dbPath);
  console.log(`[portalk] db ready: ${dbPath}`);

  // P0 消费：从成员位解析出厂 pianist 身份（判据 1）
  const members = loadMembers(membersDir);
  if (!members.ok) console.error(formatErrors(members));
  const pianist = members.tree['pianist'];
  if (!pianist) {
    console.error('[acp ] 成员位无 pianist（出厂实例必须可消费）——载入错误如上');
    db.close();
    process.exitCode = 1;
    return;
  }
  const userId = flagValue('--user') ?? 'p:tianxin'; // 监护人（pianist.yaml claim_bound_by 同源）
  console.log(`[portalk] members ok：pianist=${pianist.agent_id} · user=${userId}`);

  // 遥测目录：缺省本机 runtime 遥测面（壳落盘处）；PIANIST_TELEMETRY_DIR 可覆写
  const telemetryDir =
    flagValue('--telemetry-dir') ?? process.env.PIANIST_TELEMETRY_DIR ?? '/root/portalk-runtime/data/telemetry';

  const adapter = createAcpAdapter({
    db,
    membersDir,
    slug: 'pianist',
    userId,
    model: flagValue('--model') ?? 'zai-coding-cn/glm-5.2',
    piCommand: resolvePiBin(flagValue('--pi-bin')),
    cwd: REPO_ROOT,
    telemetryDir,
    readerIntervalMs: Number(flagValue('--reader-interval') ?? 500),
    approvalIntervalMs: Number(flagValue('--approval-interval') ?? 2000),
    env: process.env,
    onEvent: (ev) => {
      const d = ev.detail ?? {};
      const extra =
        ev.kind === 'task_progress'
          ? ` tool=${d.tool}${d.isError ? ' [error]' : ''}`
          : ev.kind === 'heartbeat'
            ? ` tokens=${d.usage?.totalTokens ?? '?'} cost=${d.usage?.cost?.total ?? '?'}`
            : ev.kind === 'session_start'
              ? ` pid=${d.pid} thread=${d.threadId}`
              : ev.kind === 'session_end'
                ? ` exit=${d.exitCode} reason=${d.reason}`
                : '';
      console.log(`[event] ${ev.shell}/${ev.kind} ref=${ev.ref}${extra}`);
    },
    onApproval: (card) => {
      console.log(`[card ] 审批卡浮出 #${card.id} [${card.action}] ${card.summary ?? ''}`);
      if (card.plainLine) console.log(`[card ]   ↳ ${card.plainLine}`);
    },
  });

  // dm 建连：--thread 指定既有窗口（th:uuid 或裸 uuid），缺省=dm 复用恰一/新建（P1a）
  let threadId = flagValue('--thread');
  if (threadId && !threadId.startsWith('th:')) threadId = `th:${threadId}`;

  try {
    console.log(`[acp ] session new：task="${task.slice(0, 60)}${task.length > 60 ? '…' : ''}"`);
    const session = await adapter.newSession({ threadId, task });
    console.log(`[acp ] thread=${session.threadId}${threadId ? '（接既有窗口）' : '（dm 建连）'} · session=${session.sessionId}`);
    console.log(`[acp ] 遥测面 agent=${session.agentName}（reader 盯 ${telemetryDir}）`);

    // 等首轮出话（流式不做：这里是轮次终点，非 token 流）；真链护栏超时不拖死 demo
    const done = await Promise.race([
      session.wait(),
      new Promise((resolve) => setTimeout(() => resolve({ exitCode: null, timeoutError: `子进程退场超时（${waitTimeoutMs}ms）` }), waitTimeoutMs)),
    ]);
    if (done.timeoutError) {
      console.error(`[acp ] ${done.timeoutError}——close 兑底后退出`);
    } else if (done.exitCode === 0 && done.reply) {
      console.log(`[acp ] pianist 回话（落库 speaker=${pianist.agent_id}）：`);
      console.log(done.reply.split('\n').map((l) => `        ${l}`).join('\n'));
    } else {
      console.error(`[acp ] 子进程退场异常：exit=${done.exitCode} signal=${done.signal ?? '-'} reply=${done.reply ? '有' : '无'}`);
      if (done.stderr) console.error(done.stderr.split('\n').slice(-5).join('\n'));
    }

    // 审批卡浮出窗：再等一个轮询节拍（卡常在任务跑动中浮，此处兜个尾）
    const grace = Number(flagValue('--approval-wait') ?? 2500);
    if (grace > 0) await new Promise((r) => setTimeout(r, grace));

    adapter.close(session, { reason: 'demo-end' });
    const msgs = listThreadMessages(db, session.threadId);
    console.log(`[acp ] close：session_end · thread 账本 ${msgs.length} 条：`);
    for (const m of msgs) {
      const head = `${m.speaker_id}（${m.role}）`;
      console.log(`        ${head}  ${m.content.slice(0, 70).replace(/\n/g, '⏎')}${m.content.length > 70 ? '…' : ''}`);
    }
    const ok = done.exitCode === 0;
    if (!ok) process.exitCode = 1;
  } catch (err) {
    console.error(`[acp ] 硬错：${err?.message ?? err}`);
    adapter.stop();
    process.exitCode = 1;
  } finally {
    adapter.stop();
    db.close();
  }
}

// ---------------------------------------------------------------------------
// serve —— P2 接线层：Portalk Server（HTTP API + WebSocket 长连）
// ---------------------------------------------------------------------------
async function serveCmd() {
  const port = Number(flagValue('--port') ?? 9200);
  const host = flagValue('--host') ?? '127.0.0.1'; // 桌面单机面，不出网
  const dbPath = resolveDbPath();
  const exportDir = flagValue('--export-dir') ?? 'data/exports';
  const db = openDb(dbPath);
  const { createPortalkServer } = await import('../src/server.mjs');
  const srv = createPortalkServer({ db, port, host, exportDir });
  const addr = await srv.start();
  console.log(`[portalk] serve 面世：http://${addr.host}:${addr.port} · ws://${addr.host}:${addr.port}/threads/<threadId>`);
  console.log(`[portalk] db=${dbPath} · exportDir=${exportDir}`);
  console.log('[portalk] API：/api/health /api/threads /api/threads/:id/messages?since=<lastSeq> /api/threads/:id/pin|unpin /api/search?q= /api/threads/:id/export');
  console.log('[portalk] EP 转发注入点未接线（epForwardStub）——WS 消息会出声 not wired in this slice，属本单形状');
  const shutdown = () => {
    console.log('\n[portalk] 收摊（SIGINT）');
    srv.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------------------
// 入口分发
// ---------------------------------------------------------------------------
if (argv[0] === 'serve') {
  argv.splice(0, 1); // 剩余旗标归 serveCmd 读
  await serveCmd();
} else if (argv[0] === 'acp' && argv[1] === 'demo') {
  argv.splice(0, 2); // 剩余旗标归 acpDemo 读
  await acpDemo();
} else {
  // 首单行为：建库 + 成员位载入亮黄灯
  const membersDir = flagValue('--members') ?? DEFAULT_MEMBERS_DIR;
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  console.log(`portalk db ready: ${dbPath}`);
  db.close();
  const result = loadMembers(membersDir);
  if (result.ok) {
    console.log(`members ok（${Object.keys(result.tree).length} 位入树）: ${Object.keys(result.tree).join(', ')}`);
  } else {
    console.error(formatErrors(result));
    const kept = Object.keys(result.tree);
    console.error(`已拒载 ${result.errors.length} 件；好件照载 ${kept.length} 位：${kept.join(', ') || '（无）'}`);
    process.exitCode = 1;
  }
}
