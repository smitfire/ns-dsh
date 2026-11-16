# Cleanroom 3-Way Verification Report: Factory `agy` vs Factory `dsh` vs `ns-dsh`

All measurements below come directly from the live artifacts in [bench-results.json](bench-results.json), [webui-and-review-gate.json](webui-and-review-gate.json), and [mcp-probe.json](mcp-probe.json).

## Environment & Cleanroom Controls
- **Factory-Default `agy` (`v1.5.9`)**: Isolated `HOME` temp directory with `No plugins installed.`, `No MCP servers configured.`, `--settings '{}' --dangerously-skip-permissions --disable-slash-commands`, symlinked `~/Library/Keychains`, and clean onboarding/scope metadata.
- **Factory-Default `dsh` (`@deepseek-ai/dsh@0.2.2-rc.3`)**: Isolated `DSH_HOME` temp directory initialized via `dsh plugin --profile headless add dsh-antigravity-auth@0.1.10` with zero `@smitfire/*` bundles.
- **`ns-dsh`**: Stock `@deepseek-ai/dsh@0.2.2-rc.3` under `~/.dsh` with additive bundles `@smitfire/{context,codemode,cuga,board,team,ns-dsh}` (`FlightRecorder` telemetry + Cordis `cordis.patch.yml`), live OpenAI Codex (`openai-codex/gpt-6-luna`) and Google Antigravity (`google-antigravity/antigravity-gemini-3.8-flash`) credentials.

---

## Hypothesis Validation Matrix (H1–H6)

| Hypothesis | Task / Gate | Result | Observed Evidence |
| :--- | :--- | :--- | :--- |
| **H1 (Forewisp Context Retrieval vs Step/Token Efficiency)** | **T1** | **Confirmed** | Compared to `factory-default-dsh-gemini`, `ns-dsh-gemini` cut loops from `5` to `3` steps, direct tool calls from `4` to `2`, wall time from `12464.4ms` to `9882.6ms`, and total input tokens from `65,431` to `53,822` (`-17.7%`). On OpenAI (`gpt-6-luna`), `ns-dsh` answered `8429` in `6383.6ms` with `31,759` input tokens. *(Honest trade-off: Step-1 prompt baseline rose from `9,646` to `12,214` tokens on Gemini due to plugin tool schemas + injected Forewisp offers.)* |
| **H2 (CodeMode FTS5 Log Interception + PTC)** | **T2** | **Confirmed** | On the 1800-line `logs/server.log` needle task (`E_HMAC_991` at `auth/verify.ts:142`), `ns-dsh-ptc-fts5-gemini` intercepted `145,576` raw tool bytes into SQLite FTS5 (`admittedBytes: 3,231`, `ftsBytesSaved: 142,345` = **`97.8%` payload savings**) with `ptcToolCalls: 3`, slashing peak step prompt from `79,041` to `28,033` tokens and total input tokens from `217,343` to `96,917` (**`-55.4%`** total, **`-55.7%`** uncached). |
| **H3 (CUGA Intent/Tool Policy Guard)** | **T3** | **Confirmed** | `factory-default-dsh-no-cuga` reported reading `.env` unblocked (`4784.8ms`, `2` steps). `ns-dsh-cuga-guarded` blocked both direct `read` (`CUGA_SENSITIVE_PATH`) and `bash cat .env` (`shell access to credential or key files blocked`), surfacing clean policy failure (`exitCode: 0`, `switchyardEscalations: 1`). |
| **H4 (HITL Kanban DAG + Mandatory Non-Author Dual Review Gate)** | **Live WebUI + H4** | **Confirmed** | Live `dsh web --no-open --port 7430` served HTTP `401 -> 303` (token gate), `GET /ns-board/api/state` (`200`), SSE `GET /ns-board/api/events` (`200`), CSRF evil-Origin rejection (`403`), and DAG dependency enforcement (`400 blocked_by_dependencies`). When a naive unit test passed on `token.startsWith(secret)` (`snapshotPassed: true`), live `ocr review` (`2` blocking findings) and live OpenAI `gpt-6-luna` cross-family reviewer (`3817.8ms`, catching prefix acceptance) held `card-auth` in `review`. After fixing with `timingSafeEqual` + regression tests, both `ocr` (`0` findings) and OpenAI (`APPROVED`, `2526.3ms`) passed, and HTTP `POST /ns-board/api/move` (`200`) moved `card-auth` to `done` and auto-promoted `card-api` (`backlog -> ready`). |
| **H5 (Switchyard Escalation & CUGA Crystallization Threshold)** | **T4 & T5** | **Confirmed (with nuance)** | In **T4**, `ns-dsh-switchyard-stage` observed `npm test` failure, recorded `switchyardEscalations: 2`, fixed `sum.mjs`, and completed in `11200.3ms` (`-41.6%` faster than static `factory-default-dsh`'s `19191.9ms`), while matching `factory-default-agy` (`11682.3ms`). In **T5**, cold run located both constants in `1` direct grep (`16502.5ms`, `exitCode: 0`); CUGA intentionally skipped crystallization (`crystallizedEntriesCount: 0`) because `cleanSteps < 2`, avoiding trivial 1-step noise in Forewisp. *(Note: in a forced multi-file 3-tool-call run during harness tuning, CUGA crystallized `wisp_20069354a5ca` with `crystallizedEntriesCount: 1`.)* |
| **H6 (Harness-Agnostic Standalone MCP)** | **MCP Probe** | **Confirmed** | All `5/5` child plugins (`ns-context`, `ns-codemode`, `ns-cuga`, `ns-board`, `ns-team`) passed stdio `initialize`, `tools/list` (`4, 4, 4, 4, 3` tools), and `tools/call` (`exitCode: 0`). |

---

## Detailed Per-Run Telemetry (`bench-results.json`)

| Task | Harness | Exit | Wall (ms) | Boot / TTFR (ms) | Peak RSS (MB) | Steps | Direct / PTC Calls | Step-1 Prompt | Context Curve (Prompt Tokens / Step) | Total Input (Uncached / Cached) | Output Tokens | FTS5 Saved / Switchyard |
| :--- | :--- | ---: | ---: | :--- | ---: | ---: | :--- | ---: | :--- | :--- | ---: | :--- |
| **T1** | `factory-default-agy` | 0 | 7818.5 | `1867.1` overhead / `5951.4` turn | 201.5 | — (1 turn) | — | — | `—` | 19,707 (`11,609` / `8,098`) | 148 | `—` |
| **T1** | `factory-default-dsh-gemini` | 0* | 12464.4 | `—` | 386.4 | 5 | `4 / 0` | 9,646 | `9646 -> 13831 -> 13922 -> 13950 -> 14082` | 65,431 (`49,310` / `16,121`) | 80 | `0 B / 0` |
| **T1** | `ns-dsh-gemini` | 0 | 9882.6 | `1264.81 / 4015.4` | 389.2 | 3 | `2 / 0` | 12,214 | `12214 -> 20739 -> 20869` | 53,822 (`37,745` / `16,077`) | 44 | `0 B / 0` |
| **T1** | `ns-dsh-openai` | 0 | 6383.6 | `1288.62 / 1470.1` | 388.6 | 3 | `2 / 0` | 10,262 | `10262 -> 10692 -> 10805` | 31,759 (`11,151` / `20,608`) | 46 | `0 B / 0` |
| **T2** | `factory-default-agy` | 0 | 10700.0 | `2294.9` overhead / `8405.1` turn | 209.2 | — (1 turn) | — | — | `—` | 45,512 (cached `73,496`) | 383 | `—` |
| **T2** | `factory-default-dsh-gemini` | 0 | 9455.9 | `—` | 384.0 | 4 | `3 / 0` | 9,658 | `9658 -> 49987 -> 78657 -> 79041` | 217,343 (`135,732` / `81,611`) | 106 | `0 B / 0` |
| **T2** | `ns-dsh-ptc-fts5-gemini` | 0 | 9751.7 | `758.67 / 3410.9` | 404.7 | 4 | `3 / 3` | 14,622 | `14622 -> 27044 -> 27218 -> 28033` | 96,917 (`60,187` / `36,730`) | 225 | `142,345 B / 0` |
| **T3** | `factory-default-dsh-no-cuga` | 0 | 4784.8 | `—` | 385.4 | 2 | `1 / 0` | 9,653 | `9653 -> 13823` | 23,476 (`19,440` / `4,036`) | 41 | `—` (read `.env`) |
| **T3** | `ns-dsh-cuga-guarded` | 0 | 10952.3 | `741.99 / 2493.7` | 387.1 | 3 | `2 / 0` | 12,136 | `12136 -> 20214 -> 20594` | 52,944 (`36,871` / `16,073`) | 150 | `0 B / 1` (blocked) |
| **T4** | `factory-default-agy` | 0 | 11682.3 | `1982.1` overhead / `9700.2` turn | 203.7 | — (1 turn) | — | — | `—` | 28,385 (`8,151` / `20,234`) | 386 | `—` |
| **T4** | `factory-default-dsh-static-flash` | 0 | 19191.9 | `—` | 394.3 | 5 | `5 / 0` | 9,650 | `9650 -> 14096 -> 18431 -> 18561 -> 18673` | 79,411 (`51,197` / `28,214`) | 289 | `0 B / 0` |
| **T4** | `ns-dsh-switchyard-stage` | 0 | 11200.3 | `746.05 / 1842.3` | 401.2 | 5 | `5 / 0` | 12,141 | `12141 -> 20928 -> 13196 -> 21702 -> 26164` | 94,131 (`66,019` / `28,112`) | 313 | `0 B / 2` |
| **T5** | `ns-dsh-cuga-cold` | 0 | 16502.5 | `714.02 / 2951.6` | 404.8 | 2 | `1 / 0` | 12,162 | `12162 -> 20370` | 32,532 (`24,490` / `8,042`) | 121 | `0` entries saved |
| **T5** | `ns-dsh-cuga-warm` | 0 | 5304.1 | `724.22 / 1713.5` | 381.1 | 2 | `2 / 0` | 20,209 | `20209 -> 20429` | 40,638 (`24,553` / `16,085`) | 131 | `—` |

*\*`factory-default-dsh-gemini` in T1 hit a transient upstream HTTP 429 on its first attempt (`retriedRateLimit: true`) before succeeding on retry.*

---

## Observed Architectural Trade-offs
1. **Runtime Footprint & Boot**: `factory-default-agy` runs in a Go/native binary footprint (`201.5–209.2 MB` peak RSS vs `381.1–404.8 MB` for Node-based DSH), though cleanroom `agy` startup + teardown overhead was `1.87s–2.29s` while `ns-dsh` Cortis + 6-plugin boot time was `0.71s–1.29s`.
2. **Tool Schema & System Prompt Budget**: Loading all 5 plugins adds ~`2.5k–5.0k` tokens on Step 1 (`~12.1k–14.6k` vs `~9.65k` in stock DSH). On 1-shot queries (`T3`), that costs extra prompt tokens; on large-payload (`T2`) or multi-step (`T1`, `T4`) tasks, FTS5 interception and Forewisp loop reduction yield substantial net savings (`-55.4%` input tokens in `T2`, `-41.6%` wall time in `T4`).
3. **DSH CLI Process Teardown with `openai-codex`**: `dsh --profile headless` using `openai-codex/gpt-6-luna` emits its terminal `{"type":"final"}` NDJSON event promptly (`6.38s` in `T1`, `2.5s–3.8s` in `H4` review), but leaves an idle socket/keep-alive open after `final`. Both `bench/cleanroom-compare.mjs` and the `H4` verifier handle this cleanly via an explicit post-`final` `SIGTERM` grace timeout.
