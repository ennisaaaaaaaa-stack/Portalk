// src/ep-connector.mjs —— EP 转发接线（P2B：router 的 epForwardStub → acp-adapter 真身）
//
// 接线形状（蓝图 §3 形状表「pin 三态」行的真身接线）：
//   routeMessage(db, msg, { epForward }) 里 epForward = createEpForward(adapter) 产物——
//   unpinned 消息真的流向 EP（thread 无活 session→newSession 建连；有→forward 续轮）；
//   pinned 不越壳（router 层已拦，本层零调用）；shell-fault 唯一自动路由（payload.auto=true
//   照流 EP——改道不改通道）。
//
// 双写防护：路由层 routeMessage 是唯一落库口（三态共通——库是真相），故本层调 adapter：
//   newSession({ taskPreStored: true })——首轮消息不再 appendMessage；
//   forward(session, text)——续轮不落库只 spawn。agent 出话回写不受影响（speaker=agent 进
//   thread 是消息闭环的正向半边，不属双写）。
//
// 会话账：threadId → session 映射（同一窗口续同一 EP 会话）；session close 后下一条消息
// 重开新 session（thread 连续性不依赖 session——P1a 判据 2 语义在转发面的同款落法）。
//
// 并发序：同 thread 消息串行排队（routeMessage 同步落库保证消息序，转发面不抢跑——
// 后到的消息等前一条的 spawn 退场再走，防续轮交错写会话文件）。

export function createEpForward(adapter, opts = {}) {
  const inflight = new Map(); // threadId → Promise（串行闸：同 thread 后到的消息排队）
  const sessions = new Map(); // threadId → session（活会话账；closed 的下次重开）
  const stats = { forwarded: 0, errors: 0, lastError: null }; // 诊断面（demo/测试）

  async function forwardOnce(threadId, message, auto) {
    let session = sessions.get(threadId);
    if (!session || session.closed) {
      // thread 无活 session：newSession 建连（taskPreStored=路由层已落库，防双写）；
      // await wait()=等首轮退场（出话回写 attachReplyOnExit 挂在 wait 上——转发完成语义含回话落库，
      // 否则上层回话回流泵拉不到增量）
      session = await adapter.newSession({ threadId, task: message.content, taskPreStored: true });
      await session.wait?.();
      sessions.set(threadId, session);
    } else {
      await adapter.forward(session, message.content); // 续轮（不落库——router 是唯一落库口）；forward 内部已等退场
    }
    return session;
  }

  // auto（shell-fault 改道）目前同通道送达：改道不改通道，出声归上层通知（已双通知）。
  // 失败自吞记账不上抛：消息已进库已广播（routeMessage 三态共通铁则），转发失败=出声面
  // 不是崩局面（server 同步调 epForward 未 await，上抛即 unhandledRejection）。
  const epForward = async function (payload) {
    const { threadId, message, auto } = payload ?? {};
    if (!threadId || !message?.content) {
      stats.errors++;
      stats.lastError = `epForward 需 {threadId, message:{content}}，收到：${JSON.stringify(payload)?.slice(0, 120)}`;
      return { ok: false, error: stats.lastError };
    }
    // 串行闸：同 thread 的转发排队（前一条没退场，后一条不动——会话文件不交错）
    const prev = inflight.get(threadId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => forwardOnce(threadId, message, auto));
    const tracked = run.finally(() => {
      if (inflight.get(threadId) === tracked) inflight.delete(threadId);
    });
    inflight.set(threadId, tracked);
    try {
      await run;
      stats.forwarded++;
      return { ok: true, session: sessions.get(threadId) };
    } catch (e) {
      stats.errors++;
      stats.lastError = e?.message ?? String(e);
      return { ok: false, error: stats.lastError };
    }
  };
  epForward.stats = stats;
  epForward.sessions = sessions;
  return epForward;
}
