// src/loader.mjs —— 成员位 manifest 载入器（P0 蓝图 §2/§3/§4）
//
// 职责：
//   1. 读 members/*.yaml（一成员一文件，members/{slug}.yaml）
//   2. 逐文件：极简 YAML 子集解析 → schema.json 校验（自写校验器，只用受支持关键字）
//   3. 坏件亮黄灯拒载（返回明确错误对象，不静默、不 crash），整套载入继续——坏件不影响好件入树
//   4. 好件进内存树（树是视图，文件是真相）
//   5. §4 不变量在此层强制（可载入时校验的四条；#5 写权审批、#6 分身不占位是 conductor 运行时/政策行为，见 REPORT）
//
// 返回 { ok, tree: {slug → manifest}, errors: [{file, stage, slug?, messages[]}] }
// stage ∈ 'read' | 'parse' | 'schema' | 'invariant'

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, YamlSyntaxError } from './yaml.mjs';
import { validateSchema } from './jsonschema.mjs';

export const DEFAULT_MEMBERS_DIR = fileURLToPath(new URL('../members', import.meta.url));

// —— §4 不变量可载入层强制清单 ——
// #1 slug 全局唯一 + agent_id↔slug 1:1（ID 稳定性走 rename 事件，载入时只验当下无冲突）
// #2 壳三态：同壳 (provider, provider_ref) 换住户时间窗不重叠（claim_bound_at..claim_released_at，缺省=开放窗口）
// #3 kind=agent 必有 identity.memory.ref（探活本身归 conductor 运行时：失败只亮黄灯不删枝）
// #4 perms 三域互不相交、无继承（同一路径不得出现在两个域）
// #5 manifest 写权推审批 —— conductor 运行时行为，不在本层
// #6 分身/临时工不占成员文件 —— 政策约束（无临时工字段可查），不在本层

export function loadMembers(membersDir = DEFAULT_MEMBERS_DIR, { schemaPath = path.join(membersDir, 'schema.json') } = {}) {
  const errors = [];
  const tree = {};

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (e) {
    // schema 是信任根：它缺失/损坏不是单件黄灯，是整套拒载（硬错，不静默也不带病跑）
    throw new Error(`schema.json 读取/解析失败（信任根缺失，整套拒载）[${schemaPath}]：${e.message}`);
  }

  const entries = fs
    .readdirSync(membersDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
    .map((e) => e.name)
    .sort();

  const loaded = []; // schema 通过者，待不变量复检
  for (const file of entries) {
    const full = path.join(membersDir, file);
    let source;
    try {
      source = fs.readFileSync(full, 'utf8');
    } catch (e) {
      errors.push({ file, stage: 'read', messages: [`读取失败：${e.message}`] });
      continue;
    }
    let manifest;
    try {
      manifest = parseYaml(source);
    } catch (e) {
      const msg = e instanceof YamlSyntaxError ? e.message : `解析失败：${e.message}`;
      errors.push({ file, stage: 'parse', messages: [msg] }); // 黄灯：单文件拒载，继续
      continue;
    }
    const v = validateSchema(schema, manifest);
    if (!v.ok) {
      errors.push({
        file,
        stage: 'schema',
        slug: typeof manifest?.slug === 'string' ? manifest.slug : undefined,
        messages: v.errors.map((x) => `${x.path}: ${x.message}`),
      });
      continue; // 黄灯
    }
    loaded.push({ file, manifest });
  }

  checkInvariants(loaded, errors);

  // 不变量也过关的才入树（坏件/违者不影响好件）
  const rejected = new Set(errors.filter((e) => e.stage === 'invariant').map((e) => e.file));
  for (const { file, manifest } of loaded) {
    if (!rejected.has(file)) tree[manifest.slug] = manifest;
  }
  return { ok: errors.length === 0, tree, errors };
}

function checkInvariants(loaded, errors) {
  const invariantErrors = new Map(); // file → messages[]
  const flag = (file, message) => {
    if (!invariantErrors.has(file)) invariantErrors.set(file, []);
    invariantErrors.get(file).push(message);
  };

  // —— #1 slug 唯一 / agent_id↔slug 1:1 / 文件名=slug（一成员一文件） ——
  const bySlug = new Map();
  const byAgentId = new Map();
  for (const { file, manifest } of loaded) {
    if (path.basename(file, '.yaml') !== manifest.slug) {
      flag(file, `文件名须为 members/{slug}.yaml（蓝图 §2 一成员一文件）：文件 ${file}，slug=${manifest.slug}`);
    }
    if (bySlug.has(manifest.slug)) {
      flag(file, `§4-1 slug 全局唯一：slug=${manifest.slug} 与 ${bySlug.get(manifest.slug)} 冲突`);
    } else {
      bySlug.set(manifest.slug, file);
    }
    if (byAgentId.has(manifest.agent_id)) {
      flag(file, `§4-1 agent_id↔slug 1:1：agent_id=${manifest.agent_id} 与 ${byAgentId.get(manifest.agent_id)} 冲突`);
    } else {
      byAgentId.set(manifest.agent_id, file);
    }
  }

  for (const { file, manifest } of loaded) {
    // —— #3 kind=agent 必有 identity.memory.ref ——
    if (manifest.kind === 'agent' && !manifest.identity?.memory?.ref) {
      flag(file, '§4-3 kind=agent 必有 identity.memory.ref（人类枝空可缺省，agent 不可）');
    }

    // —— #4 perms 三域互不相交（无继承=各域独立判读，无跨域通配语义，载入层只验不相交） ——
    const { project, interact, dialog } = manifest.perms;
    const domains = { project, interact, dialog };
    for (const [d1, list1] of Object.entries(domains)) {
      for (const [d2, list2] of Object.entries(domains)) {
        if (d1 >= d2) continue;
        const dup = list1.filter((p) => list2.includes(p));
        if (dup.length > 0) {
          flag(file, `§4-4 perms 三域互不相交：${dup.map((p) => JSON.stringify(p)).join('、')} 同时出现在 ${d1} 与 ${d2}`);
        }
      }
    }

    // —— #2 壳挂载件内校验：mount 名本树内唯一 + (provider, provider_ref) 不重复 ——
    const shells = manifest.shells ?? [];
    const mountSeen = new Set();
    const shellSeen = new Set();
    for (const s of shells) {
      if (mountSeen.has(s.mount)) flag(file, `§3 mount 挂载点名本树内唯一：重复 ${s.mount}`);
      mountSeen.add(s.mount);
      const key = `${s.provider}/${s.provider_ref}`;
      if (shellSeen.has(key)) {
        flag(file, `§4-2 同一壳 (${key}) 在本件重复挂载（顺序再占用请在单条挂载上用 claim_released_at 记账）`);
      }
      shellSeen.add(key);
      if (s.claim_released_at !== undefined && normalizeTime(s.claim_released_at) < normalizeTime(s.claim_bound_at)) {
        flag(file, `§4-2 claim 时间窗非法：${s.mount} 的 claim_released_at 早于 claim_bound_at`);
      }
    }
  }

  // —— #2 换住户时间不重叠：跨件按 (provider, provider_ref) 分组，窗口 [bound, released?∞) ——
  const shellGroups = new Map(); // provider/provider_ref → [{file, mount, start, end}]
  for (const { file, manifest } of loaded) {
    for (const s of manifest.shells ?? []) {
      const key = `${s.provider}/${s.provider_ref}`;
      if (!shellGroups.has(key)) shellGroups.set(key, []);
      shellGroups.get(key).push({ file, mount: s.mount, start: normalizeTime(s.claim_bound_at), end: s.claim_released_at !== undefined ? normalizeTime(s.claim_released_at) : null });
    }
  }
  for (const [key, claims] of shellGroups) {
    if (claims.length < 2) continue;
    const sorted = [...claims].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.file < b.file ? -1 : 1));
    for (let j = 1; j < sorted.length; j++) {
      const later = sorted[j];
      for (let i = 0; i < j; i++) {
        const earlier = sorted[i];
        // 重叠 = 后者的起点落在前者的窗口内（end=null 窗口开放；时间闭区间，同刻交接算重叠=解绑与新绑不可同刻）
        const overlaps = earlier.end === null || later.start <= earlier.end;
        if (overlaps) {
          flag(
            later.file,
            `§4-2 一台壳同一时刻至多一个住户（换住户=解绑+新绑，时间不重叠）：壳 ${key} 的 ${later.mount} [${later.start}, ${later.end ?? '开放'}] 与 ${earlier.file} 的 ${earlier.mount} [${earlier.start}, ${earlier.end ?? '开放'}] 重叠`,
          );
          break;
        }
      }
    }
  }

  for (const [file, messages] of invariantErrors) {
    const m = loaded.find((x) => x.file === file)?.manifest;
    errors.push({ file, stage: 'invariant', slug: m?.slug, messages });
  }
}

// 日期归一：纯日期补 T00:00:00，使日期/日期时间可按字符串比较
function normalizeTime(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s;
}

// 黄灯打印件（CLI/conductor 用；拒绝=出声，不静默）
export function formatErrors(result) {
  return result.errors
    .map((e) => `⚠️ [${e.stage}] ${e.file}${e.slug ? `（slug=${e.slug}）` : ''}\n  - ${e.messages.join('\n  - ')}`)
    .join('\n');
}
