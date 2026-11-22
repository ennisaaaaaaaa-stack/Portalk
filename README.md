# Portalk（驿说）

多 agent 桌面通信中枢——让 user 和多个 AI agent 在一个屋檐下对话、协作、共享记忆。

状态：早期施工。当前轨道：P0 成员位（manifest schema）+ P1a thread 层。

蓝图与施工总图见 `docs/blueprints/`。

## 启动 Server（P2 接线层）

- `node bin/portalk.mjs serve --port 9200 --db data/portalk.db`（默认 9200/data/portalk.db，Ctrl-C 收摊）
- HTTP 面：`GET /api/health`、`/api/threads`、`/api/threads/:id/messages?since=<lastSeq>`（断线补拉）、`POST /api/threads/:id/pin|unpin`（路由意图）、`/api/search?q=`、`/api/threads/:id/export`（markdown+frontmatter）
- WebSocket 面：`ws://127.0.0.1:9200/threads/<threadId>?speakerId=<成员ID>`（RFC 6455 自实现零依赖，窗口↔thread 一一对应；发 `{type:'message',…}` 收 `message/presence/shell-fault/…`）
- 测试：`npm test`（含 server.test.mjs 全链）；语法检查：`npm run check`
