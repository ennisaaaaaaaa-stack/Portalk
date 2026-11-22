// src/heartbeat.mjs —— 心跳树：触感事件→语义翻译→前端树数据面（P2 蓝图 §2 心跳树定案 / 判据 5）
//
// 三层职责：
//   1. 静态语义映射表 TOOL_PHRASES：工具名→人话短语（树上节点是人话非黑话——「在跑命令」
//      不是「bash」，对账禁黑话规矩）。定案（11-18 甜心）：翻译层静态映射表起步，零延迟才
//      保得住进度实时；LLM 逐条翻译不做。第一版翻到工具级不翻参数级；条目形状留 when 参数
//      模式位（「工具名+参数模式→语义短语」的表结构先行，参数级条目后续单再启用）。
//   2. 树状态机 createHeartbeatTree：吃 reader v0 触感事件（shell:"pianist" 统一形状），
//      维护 per-session 树节点。长静默段=「在想」（message_end 前无工具事件不是死了——
//      snapshot 时按 thinkingAfterMs 判当下态，事件驱动不设轮询钟）。
//   3. 数据面 snapshot()：HTTP 轮询（GET /api/tree）与 WS 推送（type:'tree'）共用此形状。
//      原始 detail（机械面）留在节点 activity 里给排障——同壳审批卡 machineLine/plainLine
//      双层家风：树上人话，节点里机械。
//
// 消费链：acp-adapter 的 onEvent 流（session_start/reader 映射流）→ tree.ingest →
// onChange 回调 → Server broadcastAll（WS 推）；前端断线重连后 GET /api/tree 补快照。

// —— 静态语义映射表：工具名 → 人话短语 ——
// 覆盖面=pi 常用工具族（read/bash/edit/write/grep 族）+ pianist 壳桥工具族；未匹配回落
// 「在用工具」（人话兜底，工具名进机械面 detail 不上树面）。
export const TOOL_PHRASES = [
  { tools: ['read', 'read_file', 'view', 'cat'], phrase: '在读文件' },
  { tools: ['bash', 'shell', 'exec', 'run_command', 'sandbox_execute', 'sandbox_run_in_session'], phrase: '在跑命令' },
  { tools: ['edit', 'write', 'apply_patch', 'applypatch', 'str_replace_editor', 'sandbox_write_file', 'spoor_scratch_write'], phrase: '在改文件' },
  { tools: ['grep', 'rg', 'find', 'glob', 'search', 'spoor_search', 'spoor_archive_query', 'grimoire_tag', 'grimoire_skill', 'grimoire_map'], phrase: '在找东西' },
  { tools: ['ls', 'tree', 'list_dir', 'list', 'spoor_list', 'spoor_archive_list', 'spoor_read_journal'], phrase: '在看目录' },
  { tools: ['test', 'npm_test', 'pytest', 'vitest', 'jest'], phrase: '在跑测试' },
  { tools: ['git', 'gh', 'github'], phrase: '在管代码仓' },
  { tools: ['web_search', 'search_web', 'fetch', 'curl', 'wget', 'browser', 'playwright'], phrase: '在查网上' },
  { tools: ['spawn', 'dispatch', 'task', 'delegate'], phrase: '在派分身' },
  { tools: ['mcp__pianist_bridge', 'pianist_bridge', 'bridge'], phrase: '在走桥调用' },
];

// 语义翻译：工具事件 detail → 人话短语。未匹配返回 null（树面回落「在用工具」）。
// 表序即优先序（首条命中即返）；when 是参数模式位（v0 空——第一版不翻参数级）。
export function translateToolUse(detail) {
  const tool = detail?.tool;
  if (typeof tool !== 'string' || !tool) return null;
  for (const entry of TOOL_PHRASES) {
    if (entry.when && !entry.when(detail)) continue;
    if (entry.tools.some((t) => tool === t || tool.startsWith(`${t}__`) || tool.startsWith(`${t}:`))) return entry.phrase;
  }
  return null;
}

// —— 树状态机 ——
//
// 节点形状（snapshot 输出，树面即数据面）：
//   { ref, agent, state, label, startedAt, lastEventAt,
//     activity: [{ts, tool, phrase, machine}],   // 时间线：人话短语 + 机械面（排障用）
//     beats: [{ts, tokens, cost}],               // message_end 心跳节拍（usage/cost）
//     subagents: [{ref, phrase, spawnTs, exitTs}] } // 分身分支（subagent_spawn/exit——树的下层）
//
// state ∈ 'active'（有事件在流）| 'thinking'（长静默——在想）| 'ended'（session_end）
// label = 人话短语：active→最近一条工具短语；thinking→'在想'；ended→'收工了'
export function createHeartbeatTree(opts = {}) {
  const { thinkingAfterMs = 10_000, maxActivity = 200, maxBeats = 50, now = () => new Date() } = opts;
  const sessions = new Map(); // ref → 内部节点

  function nodeOf(ev) {
    let n = sessions.get(ev.ref);
    if (!n) {
      n = { ref: ev.ref, agent: ev.detail?.agent ?? null, startedAt: ev.detail?.ts ?? now().toISOString(), lastEventAt: n2ts(ev), activity: [], beats: [], subagents: [], ended: false };
      sessions.set(ev.ref, n);
    }
    return n;
  }
  const n2ts = (ev) => ev.detail?.ts ?? now().toISOString();

  /** 吃一条触感事件（shell:"pianist" 统一形状，reader v0 / adapter session 事件同源） */
  function ingest(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.ref !== 'string') return;
    switch (ev.kind) {
      case 'session_start': {
        nodeOf(ev); // 建节点即妥（等首事件）
        break;
      }
      case 'task_progress': {
        const n = nodeOf(ev);
        const d = ev.detail ?? {};
        n.activity.push({
          ts: d.ts ?? now().toISOString(),
          tool: typeof d.tool === 'string' ? d.tool : null,
          phrase: translateToolUse(d) ?? '在用工具',
          machine: { tool: d.tool ?? null, input: d.input ?? null, isError: Boolean(d.isError), durationMs: d.durationMs ?? null },
        });
        if (n.activity.length > maxActivity) n.activity.splice(0, n.activity.length - maxActivity);
        break;
      }
      case 'subagent_spawn': {
        const n = nodeOf(ev);
        n.subagents.push({ ref: ev.detail?.subagent ?? ev.detail?.agent ?? null, phrase: '分身在干活', spawnTs: n2ts(ev), exitTs: null });
        break;
      }
      case 'subagent_exit': {
        const n = nodeOf(ev);
        const sa = [...n.subagents].reverse().find((s) => s.exitTs === null);
        if (sa) {
          sa.exitTs = n2ts(ev);
          sa.phrase = '分身收工';
        }
        break;
      }
      case 'heartbeat': {
        const n = nodeOf(ev);
        const u = ev.detail?.usage ?? {};
        n.beats.push({ ts: n2ts(ev), tokens: u.totalTokens ?? null, cost: u.cost?.total ?? null });
        if (n.beats.length > maxBeats) n.beats.splice(0, n.beats.length - maxBeats);
        break;
      }
      case 'session_end': {
        const n = nodeOf(ev);
        n.ended = true;
        break;
      }
      default:
        return; // 未知 kind 不进树（reader 出声账已管）
    }
    const n = sessions.get(ev.ref);
    if (n) n.lastEventAt = n2ts(ev);
    opts.onChange?.(snapshot()); // 数据面双口共用：WS 推走这里，HTTP 轮询走 snapshot()
  }

  /** 当下快照（HTTP 轮询口；判静默用调用时点——事件驱动不设轮询钟，树不自己滴答） */
  function snapshot() {
    const nowMs = Date.parse(now().toISOString());
    const sessionsOut = [];
    for (const n of sessions.values()) {
      let state;
      let label;
      if (n.ended) {
        state = 'ended';
        label = '收工了';
      } else {
        const silentMs = nowMs - Date.parse(n.lastEventAt);
        if (silentMs > thinkingAfterMs) {
          state = 'thinking';
          label = '在想'; // 长静默段：message_end 前无工具事件不是死了
        } else {
          state = 'active';
          const last = [...n.activity].reverse().find((a) => !a.machine.isError);
          label = last?.phrase ?? '刚开张';
        }
      }
      sessionsOut.push({
        ref: n.ref,
        agent: n.agent,
        state,
        label,
        startedAt: n.startedAt,
        lastEventAt: n.lastEventAt,
        activity: n.activity,
        beats: n.beats,
        subagents: n.subagents,
      });
    }
    return { sessions: sessionsOut, thinkingAfterMs, takenAt: now().toISOString() };
  }

  return { ingest, snapshot, size: () => sessions.size };
}
