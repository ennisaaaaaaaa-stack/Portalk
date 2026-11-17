// test/demo-smoke.mjs —— acp demo CLI 全链冒烟（零真钱：mock pi + mock 壳）
// 不进 node --test 主链（它是 CLI 端到端，慢且要保活壳）；手动跑：node test/demo-smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockShell } from './mock-shell.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-demo-smoke-'));
const telemetryDir = path.join(dir, 'telemetry');
const shell = await startMockShell({ telemetryDir });
shell.setCards([{ id: 'smoke-1', action: 'sandbox_execute', summary: '冒烟卡', plainLine: '跑一条冒烟命令' }]);
console.log(`[smoke] dir=${dir}`);
console.log(`[smoke] mock shell=${shell.url}`);

const env = { ...process.env, PIANIST_SHELL_URL: shell.url };
const out = await new Promise((resolve) => {
  const c = spawn(
    process.execPath,
    [
      'bin/portalk.mjs',
      'acp',
      'demo',
      '--db', path.join(dir, 'portalk.db'),
      '--task', '冒烟任务：回一句话',
      '--pi-bin', '/tmp/mockpi.sh',
      '--telemetry-dir', telemetryDir,
      '--approval-interval', '200',
      '--approval-wait', '800',
    ],
    { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let buf = '';
  c.stdout.on('data', (d) => (buf += d));
  c.stderr.on('data', (d) => (buf += d));
  c.on('close', (code) => resolve({ code, buf }));
});
console.log(out.buf);
const pass =
  out.code === 0 &&
  /event\] pianist\/session_start/.test(out.buf) &&
  /event\] pianist\/task_progress/.test(out.buf) &&
  /event\] pianist\/heartbeat/.test(out.buf) &&
  out.buf.includes('审批卡浮出 #smoke-1') &&
  out.buf.includes('MOCKPI-OK: 冒烟任务') &&
  /event\] pianist\/session_end/.test(out.buf) &&
  out.buf.includes('close：session_end');
console.log(pass ? '[smoke] PASS 全链：dm 建连→消息落库→事件流→审批卡→close' : '[smoke] FAIL');
await shell.close();
process.exit(pass ? 0 : 1);
