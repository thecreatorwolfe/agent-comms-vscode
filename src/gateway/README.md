# src/gateway — Owner: Codex

Per `docs/AGENT_ORCHESTRATION_CODEX_BRIEF.md` §2.

Files to implement:
- `http.ts` — Express app binding to 127.0.0.1:EXTENSION_PORT. Endpoints per protocol §7: `POST /spawn`, `POST /outbound-oneshot`, `GET /registry`
- `ws.ts` — `ws` WebSocket server on same port, path `/ws`. Frame dispatcher per protocol §6
- `auth.ts` — `ROUTER_SHARED_SECRET` validation (WS first-frame + HTTP `X-Router-Secret` header). Use `crypto.timingSafeEqual` for constant-time comparison.

Do not add new files here without asking Alfred.
