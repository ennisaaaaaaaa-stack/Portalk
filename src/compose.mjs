// src/compose.mjs —— P2 组装层：把已交付零件接成一条活线（蓝图 §1「消息闭环」的字面交付）
//
// 四零件一处收口（demo / CLI serve / 测试共用同一组装，不各接各的）：
//   1. 心跳树（G1）：adapter 的触感事件流喂 tree.ingest（session_start/reader 映射流同源）；
//      tree.onChange → server.broadcastAll（WS 推送面）；HTTP 轮询面走 /api/tree（server 内接）。
//   2. EP 转发（G3）：server 的 epForward 注入口接 createEpForward(adapter)——unpinned 真流 EP。
//   3. 回话回流：adapter 出话回写 thread（attachReplyOnExit）是静默落库——组装层在转发退场后
//      拉该 thread 增量广播（agent 回话进 WS 面，前端窗口看得到回话，消息闭环的下半边）。
//   4. 记忆提醒（G2）：opts.memoryRemind / membersDir 透传 adapter（注入点在 adapter 内部）。
//
// 各零件接口不为此层改动（server/adapter/ep-connector 保持可独立测试）——本层只做接线。

import { createAcpAdapter } from './acp-adapter.mjs';
import { createEpForward } from './ep-connector.mjs';
import { createHeartbeatTree } from './heartbeat.mjs';
import { createPortalkServer } from './server.mjs';
import { listThreadMessages } from './threads.mjs';

/**
 * 组装一台全接线的 Portalk 栈。
 *
 * @param {object} opts 透传各零件（db 必填；adapter/server/tree 的参数各自透传）——
 *   db, host, port, exportDir          → server
 *   membersDir/slug/pianistAgentId/userId/model/piCommand/piBaseArgs/cwd/sessionDir/
 *   telemetryDir/shellUrl/memoryRemind/env/onApproval  → adapter
 *   onEvent(ev)                        → adapter 触感事件旁听（树喂线之外的多口）
 *   tree                               → 缺省自建 createHeartbeatTree()（可注入测试替身）
 *   thinkingAfterMs                    → 缺省树的静默阈值
 * @returns {Promise<{srv, adapter, tree, epForward, start, close}>}
 */
export async function createPortalkStack(opts = {}) {
  const { db } = opts;
  if (!db) throw new Error('createPortalkStack 需 db（openDb 产物）');

  let srv = null; // 前向引用（tree.onChange 要广播，srv 在后面建）
  const tree = opts.tree ?? createHeartbeatTree({
    ...(opts.thinkingAfterMs != null ? { thinkingAfterMs: opts.thinkingAfterMs } : {}),
    onChange: (snap) => srv?.broadcastAll({ type: 'tree', tree: snap }),
  });

  const adapter = createAcpAdapter({
    ...opts,
    onEvent: (ev) => {
      tree.ingest(ev);
      opts.onEvent?.(ev);
    },
  });

  const epForward = createEpForward(adapter);

  // 回话回流：转发退场后拉 thread 增量广播（adapter 静默落的 agent 消息进 WS 面）。
  // 水位初始化在转发前（路由层广播过的消息不重播——首播只带 agent 回话）
  const lastSentSeq = new Map(); // threadId → 已广播的 lastSeq
  function pumpThread(threadId) {
    const msgs = listThreadMessages(db, threadId);
    const since = lastSentSeq.get(threadId) ?? 0;
    let last = since;
    for (const m of msgs) {
      if ((m.seq ?? 0) > since) srv?.broadcast(threadId, { type: 'message', ...m });
      last = Math.max(last, m.seq ?? 0);
    }
    lastSentSeq.set(threadId, last);
  }
  const epForwardWithPump = async (payload) => {
    if (payload?.threadId && !lastSentSeq.has(payload.threadId)) {
      const prior = listThreadMessages(db, payload.threadId);
      lastSentSeq.set(payload.threadId, prior.length ? (prior.at(-1).seq ?? 0) : 0);
    }
    const r = await epForward(payload);
    if (r?.ok) pumpThread(payload.threadId);
    return r;
  };

  srv = createPortalkServer({ ...opts, epForward: epForwardWithPump, tree });

  return {
    srv,
    adapter,
    tree,
    epForward,
    start: () => srv.start(),
    close: () => {
      adapter.stop();
      return srv.close();
    },
  };
}
