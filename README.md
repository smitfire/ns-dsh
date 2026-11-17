# ns-dsh

Modular plugin ecosystem for stock DeepSeek Harness (`@deepseek-ai/dsh@0.2.2-rc.3`), keeping upstream `dsh` cleanly upgradeable while mounting six independent plugin repositories (`plugins/*`) and harness-agnostic MCP servers:

- [`smitfire/context`](https://github.com/smitfire/context) (`@smitfire/context`): Forewisp dynamic context injection, Turn-1 latency cap, live SHA-256 drift gating, secret/injection firewall, and atomic CAS upserts.
- [`smitfire/codemode`](https://github.com/smitfire/codemode) (`@smitfire/codemode`): Code Mode (`PtcExecutor`) MIT SQLite FTS5 output slicing (`ctx_index`, `ctx_search`, `ctx_slice`), CUGA stateful variables (`vars_set`/`get`/`list`), `tools_discover` shortlisting, and worker-isolated `node:vm` MCP server.
- [`smitfire/cuga`](https://github.com/smitfire/cuga) (`@smitfire/cuga`): CUGA `IntentGuard`, realpath-verified `ToolGuard`, `ReasoningModeRouter`, and `TrajectoryCrystallizer`.
- [`smitfire/board`](https://github.com/smitfire/board) (`@smitfire/board`): Single-authority 6-column HITL Kanban & cycle-checked DAG natively mounted into DSH WebUI (`main`, `sidebar.panellist`, `conversation.input.dock`), `/board`, `/ns-board/api/*`, and MCP.
- [`smitfire/team`](https://github.com/smitfire/team) (`@smitfire/team`): NVIDIA NeMo Switchyard-inspired `StageRouter` (`efficient <-> capable` + `routes.toml`), isolated git-worktree workers, visible read-only Advisor (`<=2`/card), mandatory non-author Review gate (`snapshot + ocr + cross-family`), and `StallWatchdog`/`ProgressWatch` auto-resume.
- [`smitfire/tui`](https://github.com/smitfire/tui) (`@smitfire/tui`): Claude Code / `agy`-style terminal renderer, inline HITL approvals & questions, persistent `tmux` session resume, and `/ns-tui/api/*` loopback control surface.

## Commands

```bash
pnpm install
npm test
node bin/ns-dsh.mjs upgrade --dry-run
node bin/ns-dsh.mjs init --agy --switchyard
node bin/ns-dsh.mjs install
node bin/ns-dsh.mjs start
node bin/ns-dsh.mjs shutdown
```
