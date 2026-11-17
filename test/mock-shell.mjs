// test/mock-shell.mjs —— 壳替身（本地 http server，listen(0) 内核挑口——runtime 坑账：手挑随机端口撞车面）
//
// 只实现本单消费的两口（形状照抄真壳 src/shell.mjs）：
//   GET  /approvals/pending → {pending:[...]}（卡面可编程：setCards）
//   POST /telemetry/ingest  → {agent,events:[...]} 落 `<agent>-<UTC日期>.jsonl`（与真壳同命名法）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export async function startMockShell({ telemetryDir } = {}) {
  if (!telemetryDir) throw new Error('startMockShell 需 telemetryDir');
  fs.mkdirSync(telemetryDir, { recursive: true });

  let cards = [];
  const handle = {
    setCards: (next) => (cards = next),
    requests: { pending: 0, ingest: 0 },
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/approvals/pending') {
      handle.requests.pending++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pending: cards }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/telemetry/ingest') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        handle.requests.ingest++;
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }
        const agent = typeof parsed?.agent === 'string' && parsed.agent ? parsed.agent : 'unknown';
        const day = new Date().toISOString().slice(0, 10);
        const lines = (Array.isArray(parsed?.events) ? parsed.events : [])
          .filter((ev) => ev && typeof ev.kind === 'string')
          .map((ev) => JSON.stringify({ v: 1, ...ev }));
        if (lines.length > 0) {
          fs.appendFileSync(path.join(telemetryDir, `${agent}-${day}.jsonl`), lines.join('\n') + '\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, written: lines.length }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  handle.url = `http://127.0.0.1:${port}`;
  handle.close = () => new Promise((resolve) => server.close(resolve));
  return handle;
}
