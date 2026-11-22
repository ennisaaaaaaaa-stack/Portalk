// src/router.mjs —— pin 三态消息路由器（P2 蓝图 §2 T5 / §3 形状表）
//
// 三态（照抄定案，不再重议）：
//   pinned     = 指定壳不路由：消息只进库不外发（不越壳）；agent 换壳推审批——
//                本单只推事件，审批面已存在不重做（壳侧 X-Review 流程照旧）
//   unpinned   = EP 第一顺位：消息转发给 acp-adapter 的 prompt 接口——本单 stub
//                （注入点函数 epForwardStub 留 export，body throw 'not wired in this slice' 不算错）
//   shell-fault= 唯一自动路由（不经用户抉择直转 EP）+ agent/user 双通知
//                （推 {type:'shell-fault', target:'agent'|'user'} 到 thread 连接，事件先于转发送达）
//
// emit 出口由调用方注入（Server 接 WS 广播；单测接记录器）。事件次序铁则：message 先落、
// 路由事件（approval/shell-fault）后至——前端永远先见消息再见路由副作用。
//
// 系统类消息（role='system'）：不走路由三态（无成员身份、无壳可 pin）。P1a 行为层枚举守卫
// （user|agent）不动，system 归 P2 路由层直写 messages 表——speaker 记 'system' 不进成员表，
// 无轮次语义，纯通知面（蓝图判据 2 的第三类）。

import { randomUUID } from 'node:crypto';
import { appendMessage, nextThreadSeq } from './threads.mjs';

export const PIN_STATES = ['pinned', 'unpinned', 'shell-fault'];

// —— EP 转发注入点（本单 stub）：真身=acp-adapter 的 prompt 接口，后续单接线 ——
export function epForwardStub(_payload) {
  throw new Error('not wired in this slice');
}

/**
 * 路由一条消息：落库（三态共通——库是真相）→ 按 pinState 分流。
 *
 * @param {object} db           DatabaseSync（openDb 产物）
 * @param {object} msg          { threadId, speakerId, session_id, role, content, pinState }
 * @param {object} deps         { emit(ev), epForward(payload) }——缺省 emit 吞掉、epForward=stub
 * @returns {{routed, auto, pinState, message}} 路由结果（message 为落库行，含 seq）
 */
export function routeMessage(db, msg, deps = {}) {
  const { threadId, speakerId, session_id, role = 'user', content, pinState = 'unpinned' } = msg ?? {};
  if (!PIN_STATES.includes(pinState)) {
    throw new Error(`pinState 只有 ${PIN_STATES.join('|')}，收到：${JSON.stringify(pinState)}`);
  }
  const emit = deps.emit ?? (() => {});
  const epForward = deps.epForward ?? epForwardStub;

  // 落库三态共通：消息必进 thread 库（pinned=只进库不外发；未 pin/壳故障=进库且外发）
  const message = appendMessage(db, { thread_id: threadId, session_id, speaker_id: speakerId, role, content });
  emit({ type: 'message', ...message });

  if (pinState === 'pinned') {
    // pin=指定壳不路由：不外发（EP 不被调）；agent 换壳推审批（只推事件）
    emit({
      type: 'approval',
      target: 'agent',
      reason: 'pinned-shell',
      threadId,
      messageId: message.id,
      note: '消息已 pin 指定壳不外发；agent 换壳接手走审批面',
    });
    return { routed: false, auto: false, pinState, message };
  }
  if (pinState === 'shell-fault') {
    // 壳故障=唯一自动路由：双通知先送达，再直转 EP（stub 未接线时 throw 不算错——通知已落地）
    emit({ type: 'shell-fault', target: 'agent', threadId, messageId: message.id, note: '指定壳故障，已自动改道' });
    emit({ type: 'shell-fault', target: 'user', threadId, messageId: message.id, note: '指定壳故障，已自动改道' });
    epForward({ threadId, message, auto: true });
    return { routed: true, auto: true, pinState, message };
  }
  // 未 pin=EP 第一顺位
  epForward({ threadId, message, auto: false });
  return { routed: true, auto: false, pinState, message };
}

// —— 系统类消息（human/agent/system 三类跑通判据的第三类）：路由层直写，不进成员表校验 ——
export function appendSystemMessage(db, { thread_id, session_id, content, id, created_at } = {}) {
  if (!thread_id || typeof thread_id !== 'string') throw new Error('thread_id 必填（住哪个窗口）');
  if (typeof content !== 'string') throw new Error(`content 必须是字符串，收到：${typeof content}`);
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(thread_id);
  if (!thread) throw new Error(`thread 不存在：${thread_id}`);
  if (thread.deleted_at) throw new Error(`thread 已删除（墓碑），拒收消息：${thread_id}`);

  const mid = id ?? `m:${randomUUID()}`;
  db.prepare(
    "INSERT INTO messages (id, session_id, thread_id, speaker_id, role, content, created_at, seq) VALUES (?, ?, ?, 'system', 'system', ?, ?, ?)",
  ).run(mid, session_id ?? `sys:${thread_id}`, thread_id, content, created_at ?? new Date().toISOString(), nextThreadSeq(db, thread_id));
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(mid);
}
