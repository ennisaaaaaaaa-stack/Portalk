// test/fixtures.mjs —— 测试夹具生成器（可重置：删 testdata/ 目录重跑即重建）
// 所有夹具本地生成，无网络、无真钱、无真 spawn。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(TEST_ROOT, 'testdata');
export const REPO_ROOT = path.resolve(TEST_ROOT, '..');

// —— manifest 模板（好件基形；坏件在各自目录手写，保证「坏得明确」） ——
function permsBlock(name, items) {
  if (!items || items.length === 0) return `  ${name}: []`;
  return `  ${name}:\n${items.map((i) => `    - ${i}`).join('\n')}`;
}

export function agentManifest({
  slug,
  agentId,
  displayName,
  memoryRef = `tideline:///tmp/${slug}.db`,
  shells = [],
  project = [],
  interact = [],
  dialog = ['threads:own:*'],
} = {}) {
  const lines = ['manifest_version: 1', `slug: ${slug}`, 'kind: agent', `agent_id: ${agentId}`];
  if (displayName) lines.push(`display_name: ${displayName}`);
  if (memoryRef !== null) {
    lines.push('', 'identity:', '  memory:', `    ref: ${memoryRef}`, '    liveness: file');
  }
  if (shells.length > 0) {
    lines.push('', 'shells:');
    for (const s of shells) {
      lines.push(
        `  - mount: ${s.mount}`,
        `    provider: ${s.provider}`,
        `    provider_ref: ${s.providerRef}`,
        `    claim_bound_at: ${s.boundAt}`,
      );
      if (s.releasedAt) lines.push(`    claim_released_at: ${s.releasedAt}`);
      lines.push(`    claim_bound_by: ${s.boundBy}`, `    address: ${s.address}`);
    }
  }
  lines.push('', 'perms:', permsBlock('project', project), permsBlock('interact', interact), permsBlock('dialog', dialog));
  return lines.join('\n') + '\n';
}

export function humanManifest({ slug, personId, displayName, project = [], interact = [], dialog = [] } = {}) {
  const lines = [
    'manifest_version: 1',
    `slug: ${slug}`,
    'kind: human',
    `agent_id: ${personId}`,
  ];
  if (displayName) lines.push(`display_name: ${displayName}`);
  lines.push('', 'perms:', permsBlock('project', project), permsBlock('interact', interact), permsBlock('dialog', dialog));
  return lines.join('\n') + '\n';
}

// 出厂件同款挂载形状（流水：先解绑后新绑，时间不重叠）
export const ALPHA_SHELL = {
  mount: 'alpha@hermes-wsl',
  provider: 'hermes',
  providerRef: 'wsl-main',
  boundAt: '2026-11-01',
  releasedAt: '2026-11-05',
  boundBy: 'p:tianxin',
  address: 'wsl:hermes-wsl-main',
};

export function buildFixtures(dir = FIXTURES_DIR) {
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  // —— 好件：出厂 pianist 副本 + 换住户流水（alpha 解绑 11-05，beta 11-10 新绑）+ 人类成员 ——
  // 各夹具目录均自带 schema.json 副本（真实仓形状：schema 与 yaml 同住 members/）
  const schemaJson = fs.readFileSync(path.join(REPO_ROOT, 'members', 'schema.json'), 'utf8');
  for (const d of ['members-good', 'members-bad-schema', 'members-bad-invariant', 'members-bad-yaml']) {
    write(`${d}/schema.json`, schemaJson);
  }
  write('members-good/pianist.yaml', fs.readFileSync(path.join(REPO_ROOT, 'members', 'pianist.yaml'), 'utf8'));
  write('members-good/agent-alpha.yaml', agentManifest({ slug: 'agent-alpha', agentId: 'a:alpha-0001', displayName: 'Agent Alpha', shells: [ALPHA_SHELL] }));
  write(
    'members-good/agent-beta.yaml',
    agentManifest({
      slug: 'agent-beta',
      agentId: 'a:beta-0002',
      shells: [
        {
          mount: 'beta@hermes-wsl',
          provider: 'hermes',
          providerRef: 'wsl-main',
          boundAt: '2026-11-10',
          boundBy: 'p:tianxin',
          address: 'wsl:hermes-wsl-main',
        },
      ],
    }),
  );
  write('members-good/human-u.yaml', humanManifest({ slug: 'human-u', personId: 'p:u-0001', displayName: '监护人 U' }));

  // —— schema 坏件（阴控：字段缺失/类型错/枚举外/pattern 不中；好件同目录证明互不影响） ——
  write('members-bad-schema/ok-agent.yaml', agentManifest({ slug: 'ok-agent', agentId: 'a:ok-0001' }));
  write(
    'members-bad-schema/missing-perms.yaml',
    ['manifest_version: 1', 'slug: missing-perms', 'kind: agent', 'agent_id: a:mp-0002', '', 'identity:', '  memory:', '    ref: tideline:///tmp/mp.db', '    liveness: file', ''].join('\n'),
  );
  write(
    'members-bad-schema/wrong-type.yaml',
    agentManifest({ slug: 'wrong-type', agentId: 'a:wt-0003' }).replace('manifest_version: 1', 'manifest_version: "one"'),
  );
  write('members-bad-schema/bad-enum.yaml', agentManifest({ slug: 'bad-enum', agentId: 'a:be-0004' }).replace('kind: agent', 'kind: robot'));
  write('members-bad-schema/bad-pattern.yaml', agentManifest({ slug: 'Bad_Slug', agentId: 'a:bp-0005' }));

  // —— 不变量坏件（schema 全过关，载入层 §4 复检拒载；alpha 是参照好件） ——
  write('members-bad-invariant/agent-alpha.yaml', agentManifest({ slug: 'agent-alpha', agentId: 'a:alpha-0001', shells: [ALPHA_SHELL] }));
  write('members-bad-invariant/dup-slug.yaml', agentManifest({ slug: 'agent-alpha', agentId: 'a:dup-0003' }));
  write('members-bad-invariant/dup-agent-id.yaml', agentManifest({ slug: 'agent-gamma', agentId: 'a:alpha-0001' }));
  write('members-bad-invariant/agent-no-memory.yaml', agentManifest({ slug: 'agent-no-memory', agentId: 'a:nom-0004', memoryRef: null }));
  write(
    'members-bad-invariant/perms-overlap.yaml',
    agentManifest({ slug: 'perms-overlap', agentId: 'a:pov-0005', project: ['group:symposion'], interact: ['group:symposion'], dialog: [] }),
  );
  write(
    'members-bad-invariant/claim-overlap.yaml',
    agentManifest({
      slug: 'claim-overlap',
      agentId: 'a:cov-0006',
      shells: [{ ...ALPHA_SHELL, mount: 'cov@hermes-wsl', boundAt: '2026-11-03', releasedAt: '2026-11-20' }],
    }),
  );
  write(
    'members-bad-invariant/mount-dup.yaml',
    agentManifest({
      slug: 'mount-dup',
      agentId: 'a:md-0007',
      shells: [
        { mount: 'same@mount', provider: 'hermes', providerRef: 'wsl-a', boundAt: '2026-11-01', boundBy: 'p:tianxin', address: 'wsl:h-a' },
        { mount: 'same@mount', provider: 'claude', providerRef: 'wsl-b', boundAt: '2026-11-02', boundBy: 'p:tianxin', address: 'wsl:c-b' },
      ],
    }),
  );
  write('members-bad-invariant/slug-file-mismatch.yaml', agentManifest({ slug: 'someone-else', agentId: 'a:sm-0008' }));

  // —— YAML 语法坏件（parse 阶段黄灯；好件同目录证明互不影响） ——
  write('members-bad-yaml/ok-agent.yaml', agentManifest({ slug: 'ok-agent', agentId: 'a:ok-0001' }));
  write('members-bad-yaml/tab-line.yaml', 'manifest_version: 1\nslug: tab-line\n\tkind: agent\n');
  write('members-bad-yaml/broken-indent.yaml', 'manifest_version: 1\nslug: broken\n    kind: agent\n');
  write('members-bad-yaml/garbage.yaml', '::::\n');

  return dir;
}

// 测试入口：幂等重建（先清后建——删 testdata/ 后任何测试重跑都会重新生成）
export function ensureFixtures(dir = FIXTURES_DIR) {
  fs.rmSync(dir, { recursive: true, force: true });
  return buildFixtures(dir);
}

export const DIRS = {
  good: () => path.join(FIXTURES_DIR, 'members-good'),
  badSchema: () => path.join(FIXTURES_DIR, 'members-bad-schema'),
  badInvariant: () => path.join(FIXTURES_DIR, 'members-bad-invariant'),
  badYaml: () => path.join(FIXTURES_DIR, 'members-bad-yaml'),
};
