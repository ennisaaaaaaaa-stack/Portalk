// test/loader.test.mjs —— manifest 载入器：好件入树、坏件亮黄灯拒载、§4 不变量强制
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMembers, formatErrors } from '../src/loader.mjs';
import { ensureFixtures, DIRS, REPO_ROOT, agentManifest, ALPHA_SHELL } from './fixtures.mjs';

test('出厂 members/ 目录全绿入树（schema 链真跑）', () => {
  const r = loadMembers(path.join(REPO_ROOT, 'members'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.ok(r.tree.pianist);
  assert.equal(r.tree.pianist.identity.memory.liveness, 'file');
});

test('好件目录：换住户流水（先解绑后新绑）+ 人类成员全部入树', () => {
  ensureFixtures();
  const r = loadMembers(DIRS.good());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(Object.keys(r.tree).sort(), ['agent-alpha', 'agent-beta', 'human-u', 'pianist']);
});

test('schema 坏件拒载出声，好件照载（互不影响）', () => {
  ensureFixtures();
  const r = loadMembers(DIRS.badSchema());
  assert.equal(r.ok, false);
  const byFile = Object.fromEntries(r.errors.map((e) => [e.file, e]));
  assert.equal(byFile['missing-perms.yaml'].stage, 'schema');
  assert.match(byFile['missing-perms.yaml'].messages.join('\n'), /缺少必填字段：perms/);
  assert.equal(byFile['wrong-type.yaml'].stage, 'schema');
  assert.match(byFile['wrong-type.yaml'].messages.join('\n'), /类型应为 integer/);
  assert.equal(byFile['bad-enum.yaml'].stage, 'schema');
  assert.match(byFile['bad-enum.yaml'].messages.join('\n'), /robot/);
  assert.equal(byFile['bad-pattern.yaml'].stage, 'schema');
  assert.match(byFile['bad-pattern.yaml'].messages.join('\n'), /\$\.slug.*不匹配模式/);
  // 坏件不影响好件入树
  assert.deepEqual(Object.keys(r.tree), ['ok-agent']);
  // 黄灯可读
  assert.match(formatErrors(r), /⚠️ \[schema\] missing-perms\.yaml/);
});

test('不变量违者拒载：§4-1/2/3/4 全覆盖，参照好件照载', () => {
  ensureFixtures();
  const r = loadMembers(DIRS.badInvariant());
  assert.equal(r.ok, false);
  const msgs = (file) => {
    const e = r.errors.find((x) => x.file === file);
    assert.ok(e, `应有 ${file} 的错误`);
    assert.equal(e.stage, 'invariant');
    return e.messages.join('\n');
  };
  assert.match(msgs('dup-slug.yaml'), /slug 全局唯一/);
  assert.match(msgs('dup-agent-id.yaml'), /agent_id↔slug 1:1/);
  assert.match(msgs('agent-no-memory.yaml'), /identity\.memory\.ref/);
  assert.match(msgs('perms-overlap.yaml'), /三域互不相交/);
  assert.match(msgs('claim-overlap.yaml'), /时间不重叠/);
  assert.match(msgs('claim-overlap.yaml'), /hermes\/wsl-main/);
  assert.match(msgs('mount-dup.yaml'), /mount 挂载点名本树内唯一/);
  assert.match(msgs('slug-file-mismatch.yaml'), /文件名须为 members\/\{slug\}\.yaml/);
  // 参照好件（先到先得的 alpha）不受牵连
  assert.deepEqual(Object.keys(r.tree), ['agent-alpha']);
});

test('YAML 语法坏件 parse 阶段黄灯（带行号），好件照载', () => {
  ensureFixtures();
  const r = loadMembers(DIRS.badYaml());
  assert.equal(r.ok, false);
  const stages = r.errors.map((e) => e.file + ':' + e.stage);
  assert.deepEqual(stages.sort(), ['broken-indent.yaml:parse', 'garbage.yaml:parse', 'tab-line.yaml:parse']);
  assert.match(r.errors.find((e) => e.file === 'tab-line.yaml').messages[0], /第 3 行/);
  assert.deepEqual(Object.keys(r.tree), ['ok-agent']);
});

test('阴性对照·删必字段：好件删掉 perms → 拒载', () => {
  ensureFixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-neg-'));
  const schemaPath = path.join(REPO_ROOT, 'members', 'schema.json');
  const good = agentManifest({ slug: 'neg-agent', agentId: 'a:neg-0001' });
  fs.writeFileSync(path.join(dir, 'neg-agent.yaml'), good, 'utf8');
  assert.equal(loadMembers(dir, { schemaPath }).ok, true);
  // 掰断：删 perms 块（从 'perms:' 到文件尾）
  fs.writeFileSync(path.join(dir, 'neg-agent.yaml'), good.slice(0, good.indexOf('\nperms:')), 'utf8');
  const r = loadMembers(dir, { schemaPath });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].messages.join('\n'), /缺少必填字段：perms/);
});

test('时间窗翻转：改夹具 claim 时间 → 换住户唯一性判定翻转', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-flip-'));
  const schemaPath = path.join(REPO_ROOT, 'members', 'schema.json');
  fs.writeFileSync(path.join(dir, 'agent-alpha.yaml'), agentManifest({ slug: 'agent-alpha', agentId: 'a:alpha-0001', shells: [ALPHA_SHELL] }), 'utf8');

  // 解绑（11-05）之后新绑（11-06 起）= 合法换住户
  fs.writeFileSync(
    path.join(dir, 'agent-delta.yaml'),
    agentManifest({
      slug: 'agent-delta',
      agentId: 'a:delta-0002',
      shells: [{ ...ALPHA_SHELL, mount: 'delta@hermes-wsl', boundAt: '2026-11-06', releasedAt: undefined }],
    }),
    'utf8',
  );
  const ok = loadMembers(dir, { schemaPath });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(Object.keys(ok.tree).sort(), ['agent-alpha', 'agent-delta']);

  // 掰回：新绑提前到 11-03（落在 alpha 的 11-01~11-05 窗内）= 判定翻转
  fs.writeFileSync(
    path.join(dir, 'agent-delta.yaml'),
    agentManifest({
      slug: 'agent-delta',
      agentId: 'a:delta-0002',
      shells: [{ ...ALPHA_SHELL, mount: 'delta@hermes-wsl', boundAt: '2026-11-03', releasedAt: undefined }],
    }),
    'utf8',
  );
  const bad = loadMembers(dir, { schemaPath });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.find((e) => e.file === 'agent-delta.yaml').messages.join('\n'), /§4-2.*重叠/);
  assert.deepEqual(Object.keys(bad.tree), ['agent-alpha']); // 违者拒载，原住户照载
});

test('开放窗口叠加：两件同壳都未解绑 → 后绑者拒载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-open-'));
  const schemaPath = path.join(REPO_ROOT, 'members', 'schema.json');
  fs.writeFileSync(path.join(dir, 'agent-eps.yaml'), agentManifest({ slug: 'agent-eps', agentId: 'a:eps-0001', shells: [{ ...ALPHA_SHELL, mount: 'eps@hermes-wsl', releasedAt: undefined }] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'agent-zeta.yaml'), agentManifest({ slug: 'agent-zeta', agentId: 'a:zeta-0002', shells: [{ ...ALPHA_SHELL, mount: 'zeta@hermes-wsl', releasedAt: undefined, boundAt: '2026-11-20' }] }), 'utf8');
  const r = loadMembers(dir, { schemaPath });
  assert.equal(r.ok, false);
  assert.match(r.errors.find((e) => e.file === 'agent-zeta.yaml').messages.join('\n'), /重叠/);
});
