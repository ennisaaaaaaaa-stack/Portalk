// src/reader.mjs —— 遥测→触感事件管道（P1b 蓝图 §3「update stream」行：reader v0）
//
// 职责：tail 解析遥测 jsonl（`<agent>-<UTC日期>.jsonl`，每行 {v,ts,agent,kind,data}），
//       吐统一触感事件流（壳探测协议 §触感标准）：
//         event = { shell:"pianist", kind, ref, detail }
//       kind ∈ session_start|session_end|subagent_spawn|subagent_exit|task_progress|heartbeat
//
// 映射（遥测 kind → 触感 kind）：
//   tool_use    → task_progress（默认；classifyToolUse 钩子可改判 subagent_spawn/exit——遥测无
//                 原生 spawn/exit 行，分身事件的分类归 P2 接 conductor F3 事件账时再定）
//   message_end → heartbeat（usage/cost 心跳）
//   其余 kind   → 跳过（计数出声不装哑）
//
// 跨日界：遥测按天分文件（壳侧 arrival-time 落盘）。日期翻面时先排干旧文件残余
// （日界后仍有事件写进旧文件是合法时序），再从新文件 offset=0 读起。
//
// 流式不做（Q2 定案 11-17）：本管道只产工具级触感事件供触感面（心跳树/分身面）消费，
// 不进对话渲染链，无 token 流/打字机。

import fs from 'node:fs';
import path from 'node:path';

export const TOUCH_KINDS = [
  'session_start',
  'session_end',
  'subagent_spawn',
  'subagent_exit',
  'task_progress',
  'heartbeat',
];

/** 触感标准事件工厂（形状单一出口，防字段漂移） */
export function touchEvent(kind, ref, detail, shell = 'pianist') {
  if (!TOUCH_KINDS.includes(kind)) throw new Error(`触感 kind 不在标准枚举：${JSON.stringify(kind)}`);
  if (!ref || typeof ref !== 'string') throw new Error('触感 ref 必填（session_id 或 task_id）');
  return { shell, kind, ref, detail: detail ?? {} };
}

// 遥测行 → 触感事件。返回 null = 不产事件（未知 kind/坏行）。
function mapEntry(agent, entry, classifyToolUse) {
  if (!entry || typeof entry !== 'object') return null;
  switch (entry.kind) {
    case 'tool_use': {
      const kind = classifyToolUse ? classifyToolUse(entry) : 'task_progress';
      if (kind === null) return null;
      if (kind !== 'task_progress' && kind !== 'subagent_spawn' && kind !== 'subagent_exit') {
        throw new Error(`classifyToolUse 只可改判 task_progress|subagent_spawn|subagent_exit|null：${JSON.stringify(kind)}`);
      }
      return touchEvent(kind, agent, {
        agent,
        ts: entry.ts,
        tool: entry.data?.tool,
        input: entry.data?.input,
        isError: entry.data?.isError,
        durationMs: entry.data?.durationMs,
        resultBytes: entry.data?.resultBytes,
      });
    }
    case 'message_end':
      return touchEvent('heartbeat', agent, { agent, ts: entry.ts, usage: entry.data?.usage });
    default:
      return null;
  }
}

/**
 * 建 reader。
 *
 * @param {object} opts
 *   telemetryDir   遥测目录（必填）
 *   agents         盯哪些 agent：字符串或字符串数组（文件名前缀；建议每 ACP session 独占一个 agent 名）
 *   intervalMs     轮询间隔（缺省 500ms——判据「spawn/exit 事件延迟秒级可读」的余量）
 *   now            时钟注入（跨日界测试用），缺省 () => new Date()
 *   startAt        首见已存在文件时从哪读：'end'（缺省，只看新增——触感是热数据）| 'beginning'（重放全量）
 *   onEvent        事件回调 (event) => void
 *   classifyToolUse 可选钩子 (entry) => 'task_progress'|'subagent_spawn'|'subagent_exit'|null
 */
export function createReader(opts = {}) {
  const {
    telemetryDir,
    agents,
    intervalMs = 500,
    now = () => new Date(),
    startAt = 'end',
    onEvent = () => {},
    classifyToolUse,
  } = opts;
  if (!telemetryDir || typeof telemetryDir !== 'string') throw new Error('telemetryDir 必填');
  const agentList = Array.isArray(agents) ? agents : [agents];
  if (agentList.length === 0 || agentList.some((a) => typeof a !== 'string' || !a)) {
    throw new Error('agents 必填（非空字符串或数组）');
  }

  // 每 agent 的 tail 状态：file=当前盯的文件，offset=已读字节；linger=日界切换后旧文件的
  // 追尾清单（切面瞬间还有事件写进旧文件的竞态不丢——排干后无新增即退场）
  const state = new Map(agentList.map((a) => [a, { file: null, offset: 0, linger: [] }]));
  let timer = null;
  let skipped = { malformed: 0, unknownKind: 0 }; // 出声账：坏行/未知 kind 不装哑

  const fileFor = (agent, dateIso) => path.join(telemetryDir, `${agent}-${dateIso}.jsonl`);

  // 排干一个文件自 offset 起的新增字节（只读增量，不整读；文件可能不存在=无残余）
  function drain(agent, file, fromOffset) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return fromOffset; // 不存在=无可读
    }
    if (st.size < fromOffset) fromOffset = 0; // 截断/轮转：重置到头，同趟重读
    if (st.size === fromOffset) return fromOffset;
    const len = st.size - fromOffset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      fs.readSync(fd, buf, 0, len, fromOffset);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    for (const l of text.split('\n')) {
      if (l.trim() === '') continue;
      let entry;
      try {
        entry = JSON.parse(l);
      } catch {
        skipped.malformed++;
        continue;
      }
      const ev = mapEntry(entry.agent ?? agent, entry, classifyToolUse);
      if (ev) onEvent(ev);
      else if (entry && typeof entry.kind === 'string') skipped.unknownKind++;
    }
    return st.size;
  }

  /** 单次巡检（start() 内部节拍；测试可手动 tick） */
  function tick() {
    const today = now().toISOString().slice(0, 10);
    for (const [agent, s] of state) {
      // 追尾旧文件（日界竞态兜底）：排干无新增即退场
      s.linger = s.linger.filter((lg) => {
        const before = lg.offset;
        lg.offset = drain(agent, lg.file, lg.offset);
        return lg.offset !== before;
      });
      const current = fileFor(agent, today);
      if (s.file === null) {
        // 首见：从文件尾起步（触感=热数据，只看新增）；显式 'beginning' 可重放夹具全量
        s.file = current;
        if (startAt === 'beginning') {
          s.offset = drain(agent, current, 0);
        } else {
          let size = 0;
          try {
            size = fs.statSync(current).size;
          } catch {
            /* 文件还没生——正常（session 尚未上报遥测） */
          }
          s.offset = size;
        }
        continue;
      }
      if (s.file !== current) {
        // 跨日界：旧文件挂进 linger 追尾（本 tick 立即排干一次），新文件从头读
        s.linger.push({ file: s.file, offset: s.offset });
        s.linger[s.linger.length - 1].offset = drain(agent, s.file, s.offset);
        s.file = current;
        s.offset = 0;
      }
      s.offset = drain(agent, s.file, s.offset);
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    tick(); // 立即首巡：spawn/exit 事件秒级可读不靠等第一个间隔
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, start, stop, state, skipped };
}
