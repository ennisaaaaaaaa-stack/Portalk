// src/acp-adapter.mjs —— Pianist ACP adapter（P1b 蓝图 §3 形状映射表）
//
// 四形状（ACP ↔ pianist runtime 现成能力）：
//   session new       → spawn `pi -p --model <model> <task>`（驱动器 v2.3 同款），按需 spawn 无常驻
//                       （蓝图 Q1 定案）；session_id=pi 会话文件名 uuid（sessions 路径形状首单已验证）
//   prompt            → 消息进 thread（P1a appendMessage，speaker=user 身份）+ 新 spawn 续轮
//                       （--session-id 续同一会话文件）；出话回写 thread（speaker=agent 身份）
//   update stream     → reader v0（src/reader.mjs）遥测→触感事件；流式不做（Q2 定案 11-17）
//   permission req    → 轮询壳 GET /approvals/pending，新卡→回调浮出（本单只读；批/驳写面 P2）
//
// 【选型·已推翻】任务书原案「stdin 写完 task 保持打开供后续轮次」不可行：坑账先例
// （spoor portalk 2026-10-22）pi -p 等 stdin EOF 才开工，stdin 保持开=子进程死等不干活；
// 驱动器 v2.3 生产形状是 task 走 argv + stdio:['ignore','pipe','pipe']。本层照生产先例落：
// 每轮新 spawn + --session-id 续会话（会话连续性挂文件不挂进程，恰是 P1a 判据 2 语义）。
//
// session 结束：close() 发 session_end 触感事件 + 进程退场；thread 连续性不依赖 session。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createThread, getThread, joinThread, appendMessage } from './threads.mjs';
import { createReader, touchEvent } from './reader.mjs';
import { loadMembers } from './loader.mjs';

// —— P0 消费：从成员位解析 Pianist 身份（判据 1：pianist.yaml 实例能被本层消费） ——
export function resolvePianistIdentity({ membersDir, slug = 'pianist' } = {}) {
  if (!membersDir) throw new Error('resolvePianistIdentity 需 membersDir（P0 成员位目录）');
  const result = loadMembers(membersDir);
  const manifest = result.tree[slug];
  if (!manifest) {
    const errs = result.errors.map((e) => `${e.file}[${e.stage}]: ${e.messages.join('; ')}`).join(' | ');
    throw new Error(`成员位无 ${slug}（P0 出厂实例必须可消费）${result.errors.length ? `；载入错误：${errs}` : ''}`);
  }
  return { slug, agentId: manifest.agent_id, manifest };
}

/** pi 的 cwd→项目目录名编码（session-manager.js: `--${cwd 去 /: 换 -}--`），仅用于缺省 session 目录推导 */
export function encodeCwdDir(cwd) {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// pi 会话文件名形状：<UTC时间戳（: . → -）>_<uuid>.jsonl
const SESSION_FILE_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const sessionIdFromFilename = (name) => name.slice(name.indexOf('_') + 1, -'.jsonl'.length);

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 建 ACP adapter。
 *
 * @param {object} opts
 *   db                     DatabaseSync（openDb 产物）——必填
 *   pianistAgentId         Pianist 身份 ID（a:uuid；或给 membersDir+slug 由 P0 manifest 解析）
 *   membersDir / slug      P0 成员位目录（resolvePianistIdentity 路线）
 *   userId = 'p:tianxin'   user 身份（监护人；dm 的另一头）
 *   model                  缺省 'zai-coding-cn/glm-5.2'
 *   piCommand = 'pi'       pi 可执行（测试注入 node 替身）
 *   piBaseArgs = []        前置参数（测试注入 mock 脚本路径）
 *   cwd                    spawn 工作目录（缺省本仓根）
 *   sessionDir             会话项目目录：缺省 ~/.pi/agent/sessions/<encodeCwdDir(cwd)>
 *                          （与 pi 自家缺省同路；显式传给 pi --session-dir 使发现面确定）
 *   telemetryDir           遥测目录（reader 盯）——必填
 *   readerIntervalMs=500   reader 轮询间隔
 *   shellUrl               壳地址（缺省取 env.PIANIST_SHELL_URL）；空=不轮询审批
 *   approvalIntervalMs=2000
 *   fetchImpl=fetch        审批拉取实现（可注入）
 *   sessionDiscoverTimeoutMs=20000
 *   now=()=>new Date()     时钟注入
 *   env=process.env        子进程基础 env（PIANIST_AGENT_ID 会覆写为每 session 独占名）
 *   onEvent(ev)            触感事件回调（session_start/end + reader 映射流）
 *   onApproval(card)       审批卡浮出回调（新卡恰一次）
 */
export function createAcpAdapter(opts = {}) {
  const {
    db,
    userId = 'p:tianxin',
    model = 'zai-coding-cn/glm-5.2',
    piCommand = 'pi',
    piBaseArgs = [],
    cwd = path.resolve(import.meta.dirname, '..'),
    telemetryDir,
    readerIntervalMs = 500,
    shellUrl,
    approvalIntervalMs = 2000,
    fetchImpl = fetch,
    sessionDiscoverTimeoutMs = 20_000,
    now = () => new Date(),
    env = process.env,
    onEvent = () => {},
    onApproval,
  } = opts;

  if (!db) throw new Error('createAcpAdapter 需 db（openDb 产物）');
  if (!telemetryDir) throw new Error('createAcpAdapter 需 telemetryDir（reader 盯的遥测目录）');

  const pianistAgentId = opts.pianistAgentId ?? (opts.membersDir ? resolvePianistIdentity(opts).agentId : undefined);
  if (!pianistAgentId) throw new Error('需 pianistAgentId 或 membersDir（P0 manifest 解析身份）');

  const sessionDir = opts.sessionDir ?? path.join(os.homedir(), '.pi', 'agent', 'sessions', encodeCwdDir(cwd));
  const shell = shellUrl ?? env.PIANIST_SHELL_URL ?? null;

  const emit = (kind, ref, detail) => onEvent(touchEvent(kind, ref, detail));

  // —— permission request：轮询壳审批卡（只读消费；批/驳写面 P2） ——
  let approvalTimer = null;
  const seenCards = new Set();
  const approvals = { floated: 0, errors: 0 };

  async function pollApprovalsOnce() {
    let res;
    try {
      res = await fetchImpl(`${shell.replace(/\/$/, '')}/approvals/pending`);
    } catch {
      approvals.errors++; // 壳不在场：容错继续轮（壳故障双通知是 P2 的 T5 pin 三态）
      return;
    }
    if (!res.ok) {
      approvals.errors++;
      return;
    }
    let body;
    try {
      body = await res.json();
    } catch {
      approvals.errors++;
      return;
    }
    for (const card of body?.pending ?? []) {
      if (!card || card.id === undefined) continue;
      const key = String(card.id);
      if (seenCards.has(key)) continue; // 去重：新卡恰浮一次
      seenCards.add(key);
      approvals.floated++;
      onApproval?.(card);
    }
  }

  function startApprovals() {
    if (approvalTimer || !shell || !onApproval) return;
    approvalTimer = setInterval(pollApprovalsOnce, approvalIntervalMs);
    approvalTimer.unref?.();
    pollApprovalsOnce(); // 立即首巡：卡不等人
  }

  function stopApprovals() {
    if (approvalTimer) {
      clearInterval(approvalTimer);
      approvalTimer = null;
    }
  }

  // —— spawn（驱动器 v2.3 生产形状：task/prompt 走 argv，stdin ignore——见文件头坑账引注） ——
  function spawnPi(args, agentName) {
    const child = spawn(piCommand, [...piBaseArgs, ...args], {
      cwd,
      env: { ...env, PIANIST_AGENT_ID: agentName },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, exit };
  }

  // —— session 文件发现：spawn 前后目录快照差分（不误抓并行的其他 pi 会话——mtime 法会） ——
  async function discoverSessionFile(before) {
    const deadline = Date.now() + sessionDiscoverTimeoutMs;
    for (;;) {
      const fresh = readdirSafe(sessionDir).filter((n) => SESSION_FILE_RE.test(n) && !before.has(n));
      for (const name of fresh) {
        const file = path.join(sessionDir, name);
        try {
          const header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n', 1)[0] || '{}');
          if (header.type === 'session' && header.id === sessionIdFromFilename(name)) {
            return { sessionId: header.id, file };
          }
        } catch {
          /* 写到一半的行：下一轮再看 */
        }
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // —— 出话回写 thread（判据 2：pianist 出话落消息 speaker=身份 ID） ——
  async function attachReplyOnExit(session, exitPromise) {
    const r = await exitPromise;
    const exitCode = r.code ?? null;
    if (exitCode === 0) {
      const reply = r.stdout.trim();
      if (reply) {
        appendMessage(db, {
          thread_id: session.threadId,
          session_id: session.sessionId,
          speaker_id: pianistAgentId,
          role: 'agent',
          content: reply,
        });
        return { exitCode, signal: r.signal ?? null, stderr: r.stderr, reply };
      }
    }
    return { exitCode, signal: r.signal ?? null, stderr: r.stderr, reply: null }; // 非零退场/空出话：不落 agent 消息，出声归调用方（exitCode/stderr 在手）
  }

  const openSessions = new Set();

  /**
   * session new（ACP 形状 1）。
   * @param {object} p
   *   threadId  挂哪个 thread（缺省=dm 建连：createThread 复用恰一/新建）
   *   task      首轮任务（user 消息，进 thread + 作 pi 首轮 prompt）
   *   agentName 遥测独占名（缺省 pianist-acp-<短uuid>；一名一会话→遥测文件即会话事件面）
   */
  async function newSession({ threadId, task, agentName } = {}) {
    if (!task || typeof task !== 'string') throw new Error('newSession 需 task（首轮任务）');

    // thread 建连/挂接（P1a：dm 复用恰一；显式 threadId=接既有窗口）
    let thread;
    if (threadId) {
      thread = getThread(db, threadId);
      if (!thread) throw new Error(`thread 不存在：${threadId}`);
      if (thread.deleted_at) throw new Error(`thread 已删除（墓碑），不可开 session：${threadId}`);
      joinThread(db, thread.id, userId); // 幂等：dm 恒在；topic 补挂
      joinThread(db, thread.id, pianistAgentId);
    } else {
      thread = createThread(db, { type: 'dm', createdBy: userId, memberIds: [userId, pianistAgentId] });
    }

    const name = agentName ?? `pianist-acp-${randomUUID().slice(0, 8)}`;
    const before = new Set(readdirSafe(sessionDir));

    const spawned = spawnPi(['-p', '--model', model, '--session-dir', sessionDir, task], name);
    const session = {
      sessionId: null,
      threadId: thread.id,
      agentName: name,
      child: spawned.child,
      reader: null,
      closed: false,
      wait: null,
    };
    openSessions.add(session);

    const found = await discoverSessionFile(before);
    if (!found) {
      spawned.child.kill('SIGTERM');
      openSessions.delete(session);
      throw new Error(`session 文件发现超时（${sessionDiscoverTimeoutMs}ms，目录 ${sessionDir}）——子进程已杀，thread 未落消息`);
    }
    session.sessionId = found.sessionId;
    session.sessionFile = found.file;

    // 首轮 user 消息落库（双指针国法：thread_id 归 Portalk，session_id 归 EP——落库以发现为闸，防假指针）
    appendMessage(db, {
      thread_id: session.threadId,
      session_id: session.sessionId,
      speaker_id: userId,
      role: 'user',
      content: task,
    });

    // update stream：reader 盯本会话独占的遥测 agent 文件（agentName 每 session 独占，
    // 故 startAt:'beginning' 不会重放外来历史——只防事件先于发现落盘的竞态）
    session.reader = createReader({ telemetryDir, agents: [name], intervalMs: readerIntervalMs, startAt: 'beginning', now, onEvent });
    session.reader.start();

    session.wait = () => attachReplyOnExit(session, spawned.exit);
    emit('session_start', found.sessionId, { threadId: session.threadId, agentName: name, pid: spawned.child.pid, task });
    return session;
  }

  /**
   * prompt（ACP 形状 2）：user 消息进 thread + 续轮 spawn（--session-id 续同一会话文件）。
   * 进程退场≠session 结束（每轮新 spawn 是 Q1 定案形状；session 结束走 close）。
   */
  async function prompt(session, text) {
    if (!session || !session.sessionId) throw new Error('prompt 需活 session（newSession 产物）');
    if (session.closed) throw new Error('session 已 close，不可再 prompt');
    if (!text || typeof text !== 'string') throw new Error('prompt 需 text');

    appendMessage(db, {
      thread_id: session.threadId,
      session_id: session.sessionId,
      speaker_id: userId,
      role: 'user',
      content: text,
    });
    const spawned = spawnPi(
      ['-p', '--model', model, '--session-dir', sessionDir, '--session-id', session.sessionId, text],
      session.agentName,
    );
    return attachReplyOnExit(session, spawned.exit);
  }

  /** session 结束：close 触感事件 + 进程退场；thread 不动（连续性不依赖 session——P1a 判据 2） */
  function close(session, { reason = 'closed' } = {}) {
    if (!session || session.closed) return;
    session.closed = true;
    openSessions.delete(session);
    if (session.child.exitCode === null && !session.child.killed) session.child.kill('SIGTERM');
    session.reader?.stop();
    emit('session_end', session.sessionId, {
      threadId: session.threadId,
      agentName: session.agentName,
      exitCode: session.child.exitCode,
      reason,
    });
  }

  /** 全量收摊（demo 退出用）：关活 session + 停审批轮询 */
  function stop() {
    for (const s of [...openSessions]) close(s, { reason: 'adapter-stop' });
    stopApprovals();
  }

  startApprovals();

  return {
    newSession,
    prompt,
    close,
    stop,
    // 诊断面（demo/测试用）
    approvals,
    identity: { pianistAgentId, userId, model, sessionDir, shellUrl: shell },
  };
}
