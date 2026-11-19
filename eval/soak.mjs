#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runDshHeadless } from '../bench/cleanroom-compare.mjs';
import { ToolGuard } from '../plugins/cuga/dist/core/index.js';
import { classifyToolSemantics, ProgressWatch, SwitchyardStageRouter, verifySnapshotTests } from '../plugins/team/dist/core/index.js';
import { childPath, createGitFixtureRepo, readJevBudgetLedger } from './_shared.mjs';

const execFileAsync = promisify(execFile);

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT_DIR, 'bin', 'ns-dsh.mjs');
const FOREWISP_BIN = join(ROOT_DIR, '.local', 'forewisp-target', 'release', 'forewisp');
const BUDGET_DB = process.env.NS_JEV_BUDGET_DB || join(ROOT_DIR, '.local', 'e2e', 'jev-budget.sqlite');
const DSH_NATIVE_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

const SOAK_STATE_DIR = join(ROOT_DIR, '.local', 'e2e', 'soak-host');
const HEARTBEAT_PATH = join(ROOT_DIR, '.local', 'e2e', 'soak-heartbeat.json');
const OUTPUT_PATH = join(ROOT_DIR, '.local', 'e2e', 'gate7-soak.json');

const SOAK_PORT = Number(process.env.NS_SOAK_PORT || 17435);
const SOAK_FW_PORT = Number(process.env.NS_SOAK_FW_PORT || 18795);

function parseHours() {
  const i = process.argv.indexOf('--hours');
  if (i >= 0 && process.argv[i + 1]) {
    const h = Number(process.argv[i + 1]);
    if (Number.isFinite(h) && h > 0) return h;
  }
  return 2;
}

const INSPECTIONS = [
  { name: 'ns-dsh', dir: ROOT_DIR, file: 'bin/ns-dsh.mjs', question: 'Which environment variable and CLI flag configure the isolated persistent state dir?' },
  { name: 'forewisp', dir: process.env.FOREWISP_REPO || resolve(ROOT_DIR, '..', 'forewisp'), file: 'README.md', question: 'What strategy name does Forewisp advertise when JEV decision client is active?' },
  { name: 'plugins/context', dir: ROOT_DIR, file: 'plugins/context/src/core/validator.ts', question: 'What schema string does KNOWLEDGE_SCHEMA_ID enforce?' },
  { name: 'plugins/codemode', dir: ROOT_DIR, file: 'plugins/codemode/src/core/tool-shortlister.ts', question: 'What purpose does ToolShortlister serve for large tool catalogs?' },
  { name: 'plugins/cuga', dir: ROOT_DIR, file: 'plugins/cuga/src/core/policy-guard.ts', question: 'Which sensitive file names or patterns does ToolGuard deny?' },
  { name: 'plugins/board', dir: ROOT_DIR, file: 'plugins/board/src/core/kanban-store.ts', question: 'What columns exist in BOARD_COLUMNS and how are cycles prevented?' },
  { name: 'plugins/team', dir: ROOT_DIR, file: 'plugins/team/src/core/switchyard-router.ts', question: 'When does SwitchyardStageRouter escalate and de-escalate?' },
  { name: 'plugins/tui', dir: ROOT_DIR, file: 'plugins/tui/src/dsh/index.ts', question: 'Which header/token guard protects /ns-tui/api/attach?' },
];

function atomicJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function sha256Text(s) {
  return createHash('sha256').update(s).digest('hex');
}

function readBudget() {
  return readJevBudgetLedger(FOREWISP_BIN, BUDGET_DB);
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json', ...(opts.headers ?? {}) } : opts.headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { rawText: text };
    }
  }
  return { ok: res.ok, status: res.status, json };
}

let lastBeat = 0;
let lastGapMs = 0;
let maxStallGapMs = 0;
let maxChildRunGapMs = 0;
let osSuspendedMs = 0;
const osSuspendEvents = [];
let networkOutageMs = 0;
const networkOutageEvents = [];

function recordBeat(maxAllowedGapMs = 120_000, { childBound = false, noThrow = false } = {}) {
  const now = Date.now();
  const prevBeat = lastBeat;
  lastBeat = now;
  lastGapMs = 0;
  if (prevBeat > 0) {
    const gap = now - prevBeat;
    lastGapMs = gap;
    if (childBound) {
      if (gap > maxChildRunGapMs) maxChildRunGapMs = gap;
    } else if (gap > maxStallGapMs) {
      maxStallGapMs = gap;
    }
    if (!noThrow) {
      assert.ok(gap <= maxAllowedGapMs, `Soak heartbeat gap exceeded ${maxAllowedGapMs}ms (${gap}ms)`);
    }
  }
  return now;
}

async function withAsyncSuspendTracking(fn) {
  let prev = Date.now();
  const checkJump = () => {
    const cur = Date.now();
    const jump = cur - prev;
    prev = cur;
    if (jump > 5_000) {
      const delta = jump - 1_000;
      osSuspendedMs += delta;
      lastBeat = Math.min(cur, lastBeat + delta);
      osSuspendEvents.push({ resumedAt: new Date(cur).toISOString(), suspendMs: delta });
    }
  };
  const iv = setInterval(checkJump, 1_000);
  iv.unref();
  try {
    return await fn();
  } finally {
    clearInterval(iv);
    checkJump();
  }
}

async function isExternalNetworkReachable() {
  const probes = ['https://www.gstatic.com/generate_204', 'https://api.openai.com/v1/models'];
  const checks = await Promise.allSettled(
    probes.map((url) => fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4000) })),
  );
  return checks.some((c) => c.status === 'fulfilled' && c.value.status > 0);
}

async function waitForExternalNetwork(maxWaitMs = 45 * 60_000) {
  if (await withAsyncSuspendTracking(() => isExternalNetworkReachable())) {
    recordBeat();
    return 0;
  }
  recordBeat();
  const outageStart = Date.now();
  const suspendAtOutageStart = osSuspendedMs;
  while (Date.now() - outageStart - (osSuspendedMs - suspendAtOutageStart) < maxWaitMs) {
    await withAsyncSuspendTracking(() => delay(5_000));
    const ok = await withAsyncSuspendTracking(() => isExternalNetworkReachable());
    recordBeat();
    if (ok) {
      const waitedMs = Math.max(0, Date.now() - outageStart - (osSuspendedMs - suspendAtOutageStart));
      networkOutageMs += waitedMs;
      networkOutageEvents.push({ restoredAt: new Date().toISOString(), durationMs: waitedMs });
      return waitedMs;
    }
  }
  throw new Error(`External network remained unreachable for > ${Math.round(maxWaitMs / 60_000)}m`);
}

async function pollDaemonHealthWithWakeGrace() {
  return withAsyncSuspendTracking(async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const [fwHealth, tuiSt, boardSt] = await Promise.all([
          httpJson(`http://127.0.0.1:${SOAK_FW_PORT}/health`),
          httpJson(`http://127.0.0.1:${SOAK_PORT}/ns-tui/api/status`),
          httpJson(`http://127.0.0.1:${SOAK_PORT}/ns-board/api/state`),
        ]);
        if (fwHealth.ok && fwHealth.json?.strategy === 'jev' && tuiSt.ok && boardSt.ok) {
          return { fwHealth, tuiSt, boardSt };
        }
      } catch {
        /* retry post-wake transient socket error */
      }
      await delay(2000);
    }
    throw new Error('ns-dsh or Forewisp JEV unhealthy during soak');
  });
}

async function runReadonlyInspection(item, fwToken, providerIndex) {
  const beforeGit = execFileSync('git', ['-C', item.dir, 'status', '--porcelain'], { encoding: 'utf8' });
  const route =
    providerIndex % 2 === 0
      ? { provider: 'google-antigravity', model: 'antigravity-gemini-4-hydrogen' }
      : { provider: 'openai-codex', model: 'gpt-6-luna' };
  const prompt = `Read-only inspection of ${item.file} in this repository. Do NOT create or modify any file. Answer concisely in 2 sentences citing line or symbol names: ${item.question}`;
  let lastAttemptRes = null;
  let lastErr = null;
  const retryDelaysMs = [10_000, 20_000, 35_000, 50_000, 60_000];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    let attemptRes = null;
    try {
      await waitForExternalNetwork();
      recordBeat();
      try {
        attemptRes = await withAsyncSuspendTracking(() =>
          runDshHeadless({
            dshHome: DSH_NATIVE_HOME,
            cwd: item.dir,
            prompt,
            provider: route.provider,
            model: route.model,
            reasoningEffort: 'low',
            label: `soak-inspect-${item.name}`,
            extraEnv: {
              FOREWISP_URL: `http://127.0.0.1:${SOAK_FW_PORT}`,
              NS_FOREWISP_URL: `http://127.0.0.1:${SOAK_FW_PORT}`,
              FOREWISP_API_TOKEN: fwToken,
              NS_BOARD_DB_PATH: ':memory:',
            },
          }),
        );
      } finally {
        recordBeat(380_000, { childBound: true, noThrow: true });
      }
      assert.ok(lastGapMs <= 380_000, `Inspection ${item.name} exceeded 380s child bound (${lastGapMs}ms)`);
      lastAttemptRes = attemptRes;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    const afterAttemptGit = execFileSync('git', ['-C', item.dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(afterAttemptGit, beforeGit, `Inspection on ${item.name} modified repository working tree!`);
    if (attemptRes && !lastErr && attemptRes.exitCode === 0 && (attemptRes.unknownCalls ?? 0) === 0) break;
    if (attempt < retryDelaysMs.length) {
      await withAsyncSuspendTracking(() => delay(retryDelaysMs[attempt]));
      recordBeat();
      await waitForExternalNetwork();
      await pollDaemonHealthWithWakeGrace().catch((healthErr) => {
        lastErr = lastErr ?? healthErr;
      });
    }
  }
  if (lastErr) throw lastErr;
  const res = lastAttemptRes;
  const afterGit = execFileSync('git', ['-C', item.dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(afterGit, beforeGit, `Inspection on ${item.name} modified repository working tree!`);
  assert.equal(
    res.exitCode,
    0,
    `Inspection ${item.name} exited ${res.exitCode}: ${res.errorMessage || ''} ${res.stderrTail || ''}`.trim(),
  );
  assert.equal(res.unknownCalls ?? 0, 0, `Unknown token usage in ${item.name}`);
  return {
    target: item.name,
    provider: route.provider,
    model: route.model,
    passed: res.exitCode === 0 && afterGit === beforeGit,
    dirtyUnchanged: afterGit === beforeGit,
    wallMs: res.wallMs,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    unknownCalls: res.unknownCalls ?? 0,
  };
}

async function runFeatureWave(waveIdx, fwToken) {
  const useCodex = waveIdx % 2 === 1;
  const provider = useCodex ? 'openai-codex' : 'google-antigravity';
  const model = useCodex ? 'gpt-6-luna' : 'antigravity-gemini-4-hydrogen';
  let lastResult = null;
  const retryDelaysMs = [10_000, 20_000, 35_000, 50_000, 60_000];
  const pkg = JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test/app.test.mjs' } });
  const testCode = `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { boundedAdd } from '../src/calc.mjs';\ntest('boundedAdd', () => {\n  assert.equal(boundedAdd(2, 3, 10), 5);\n  assert.equal(boundedAdd(8, 5, 10), 10);\n  assert.equal(boundedAdd(-5, -2, 0), 0);\n});\n`;
  const pkgSha = sha256Text(pkg);
  const testSha = sha256Text(testCode);

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    await waitForExternalNetwork();
    const dir = createGitFixtureRepo(`ns-soak-wave-${waveIdx}-${attempt}-`, 'soak@example.invalid', 'Soak', {
      'package.json': pkg,
      'src/calc.mjs': 'export function boundedAdd(a, b, cap) { return a + b; }\n',
      'test/app.test.mjs': testCode,
    });
    try {
      recordBeat();
      let fixRes;
      try {
        fixRes = await withAsyncSuspendTracking(() =>
          runDshHeadless({
            dshHome: DSH_NATIVE_HOME,
            cwd: dir,
            prompt: 'Fix boundedAdd(a, b, cap) in src/calc.mjs so results are clamped to [0, cap]. Do not modify package.json or test/app.test.mjs. Run node --test test/app.test.mjs.',
            provider,
            model,
            reasoningEffort: 'low',
            label: `soak-wave-${waveIdx}`,
            extraEnv: {
              FOREWISP_URL: `http://127.0.0.1:${SOAK_FW_PORT}`,
              NS_FOREWISP_URL: `http://127.0.0.1:${SOAK_FW_PORT}`,
              FOREWISP_API_TOKEN: fwToken,
              NS_BOARD_DB_PATH: ':memory:',
            },
          }),
        );
      } finally {
        recordBeat(380_000, { childBound: true, noThrow: true });
      }
      assert.ok(lastGapMs <= 380_000, `Feature wave ${waveIdx} exceeded 380s child bound (${lastGapMs}ms)`);
      const snap = verifySnapshotTests(dir, 'node --test test/app.test.mjs', { timeoutMs: 25_000 });
      const testsUnchanged =
        sha256Text(readFileSync(join(dir, 'package.json'), 'utf8')) === pkgSha &&
        sha256Text(readFileSync(join(dir, 'test/app.test.mjs'), 'utf8')) === testSha;
      lastResult = {
        wave: waveIdx,
        provider,
        model,
        passed: fixRes.exitCode === 0 && snap.passed && testsUnchanged && (fixRes.unknownCalls ?? 0) === 0,
        testsUnchanged,
        wallMs: fixRes.wallMs,
        unknownCalls: fixRes.unknownCalls ?? 0,
      };
      if (lastResult.passed) return lastResult;
    } catch (attemptErr) {
      lastResult = {
        wave: waveIdx,
        provider,
        model,
        passed: false,
        testsUnchanged: false,
        wallMs: 0,
        unknownCalls: 0,
        error: attemptErr instanceof Error ? attemptErr.message : String(attemptErr),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (attempt < retryDelaysMs.length) {
      await withAsyncSuspendTracking(() => delay(retryDelaysMs[attempt]));
      recordBeat();
      await waitForExternalNetwork();
      await pollDaemonHealthWithWakeGrace().catch(() => {});
    }
  }
  return lastResult;
}

async function runFaultInjections() {
  // a) CUGA ToolGuard deny on .env write
  const guard = new ToolGuard();
  const cugaDeny = guard.evaluate({ toolName: 'write_file', args: { path: '.env', content: 'SECRET=1' }, workspaceRoot: ROOT_DIR });
  assert.equal(cugaDeny.decision, 'deny');

  // b) Switchyard tool_semantics, inferCardTier, escalation on failing test -> de-escalation after 3 clean steps
  assert.equal(classifyToolSemantics('bash', 'npm test'), 'verify');
  const sw = new SwitchyardStageRouter({ deescalateAfterCleanSteps: 3 });
  assert.equal(sw.inferCardTier({ title: 'Security auth refactor', writeScopes: ['a.ts', 'b.ts', 'c.ts'] }), 'capable');
  sw.recordToolOutcome({ sessionId: 'soak-f', toolName: 'bash', argsSummary: 'npm test', isError: true, outputPreview: 'AssertionError' });
  assert.equal(sw.stateFor('soak-f').activeTier, 'capable');
  for (let i = 0; i < 3; i += 1) {
    sw.recordToolOutcome({ sessionId: 'soak-f', toolName: 'read_file', argsSummary: `f${i}.ts`, isError: false });
  }
  assert.equal(sw.stateFor('soak-f').activeTier, 'efficient');

  // c) ProgressWatch loop/fingerprint detection (>= 3 identical calls flagged)
  const pw = new ProgressWatch(3);
  pw.observe('bash', 'failing-cmd', 'ERR');
  pw.observe('bash', 'failing-cmd', 'ERR');
  const trippedOnThird = pw.observe('bash', 'failing-cmd', 'ERR');
  assert.equal(trippedOnThird, true);
  assert.equal(pw.isTripped(), true);
  assert.equal(pw.getRepeatCount(), 3);

  // d) Bounded AbortSignal check (< 500ms) with real fetch abort
  const ac = new AbortController();
  const t0 = performance.now();
  ac.abort(new Error('soak cancel check'));
  await assert.rejects(() => fetch('http://127.0.0.1:1', { signal: ac.signal }));
  const cancelMs = performance.now() - t0;
  assert.ok(ac.signal.aborted && cancelMs < 500);

  return { passed: true, cugaBlocked: true, switchyardEscalateDeescalate: true, loopDetectedAt: pw.getRepeatCount(), cancelMs: Number(cancelMs.toFixed(2)) };
}

const TARGET_HOURS = parseHours();
const TARGET_MS = Math.round(TARGET_HOURS * 3_600_000);

rmSync(SOAK_STATE_DIR, { recursive: true, force: true });
mkdirSync(SOAK_STATE_DIR, { recursive: true, mode: 0o700 });

for (const item of INSPECTIONS) {
  assert.ok(existsSync(item.dir), `Inspection repo missing: ${item.dir}`);
  assert.ok(existsSync(join(item.dir, item.file)), `Inspection file missing: ${join(item.dir, item.file)}`);
  const insideTree = execFileSync('git', ['-C', item.dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim();
  assert.equal(insideTree, 'true', `Inspection dir is not a git work tree: ${item.dir}`);
}

const SOAK_ENV = {
  ...process.env,
  PATH: childPath(),
  NS_BOARD_DB_PATH: join(SOAK_STATE_DIR, 'soak-board.db'),
  NS_JEV_BUDGET_DB: BUDGET_DB,
};

let shutdownDone = false;
function shutdownSoakSync() {
  if (shutdownDone) return;
  shutdownDone = true;
  spawnSync(process.execPath, [CLI_BIN, 'shutdown', '--state-dir', SOAK_STATE_DIR], { env: SOAK_ENV, stdio: 'ignore', timeout: 20_000 });
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shutdownSoakSync();
    process.exit(130);
  });
}

let cycles = 0;
let totalUnknownCalls = 0;
const inspectionsDone = [];
const featureWavesDone = [];
let faultsReport = null;
let concurrentPlanOk = false;
let midSoakSurfaces = null;
let midSoakRestart = null;

try {
  const startJson = JSON.parse(
    execFileSync(
      process.execPath,
      [CLI_BIN, 'start', '--port', String(SOAK_PORT), '--forewisp-port', String(SOAK_FW_PORT), '--state-dir', SOAK_STATE_DIR],
      { encoding: 'utf8', env: SOAK_ENV, timeout: 45_000 },
    ),
  );
  assert.equal(startJson.ok, true);
  assert.equal(startJson.forewispRunning, true);
  const fwToken = readFileSync(join(SOAK_STATE_DIR, 'forewisp.token'), 'utf8').trim();

  const startedAt = Date.now();
  lastBeat = startedAt;

  // Trigger unit fault injection suite right away
  faultsReport = await runFaultInjections();
  const milestonesIncomplete = () =>
    inspectionsDone.length < INSPECTIONS.length || featureWavesDone.length < 1 || !midSoakSurfaces || !midSoakRestart;

  while (Date.now() - startedAt - osSuspendedMs < TARGET_MS || milestonesIncomplete()) {
    const now = recordBeat();
    cycles += 1;
    const elapsedMs = now - startedAt - osSuspendedMs;

    // 1. Live daemon + WebUI + Forewisp JEV + budget health poll
    const { boardSt } = await pollDaemonHealthWithWakeGrace();
    const budget = readBudget();
    assert.equal(budget.blocked, false, 'Shared JEV budget unexpectedly blocked during soak');

    // 2. Schedule codebase inspections spaced across the soak (1 every ~10% of soak duration)
    const nextInspIdx = inspectionsDone.length;
    if (nextInspIdx < INSPECTIONS.length && elapsedMs >= (nextInspIdx * TARGET_MS) / (INSPECTIONS.length + 1)) {
      const item = INSPECTIONS[nextInspIdx];
      const postCardRes = await withAsyncSuspendTracking(() =>
        httpJson(`http://127.0.0.1:${SOAK_PORT}/ns-board/api/cards`, {
          method: 'POST',
          body: { id: `soak-insp-${nextInspIdx}`, title: `Inspect ${item.name}`, owner: 'inspector' },
        }),
      );
      assert.equal(postCardRes.ok, true, `Failed creating soak inspection card (${postCardRes.status})`);
      const res = await runReadonlyInspection(item, fwToken, nextInspIdx);
      recordBeat();
      totalUnknownCalls += res.unknownCalls;
      const moveCardRes = await withAsyncSuspendTracking(() =>
        httpJson(`http://127.0.0.1:${SOAK_PORT}/ns-board/api/move`, {
          method: 'POST',
          body: { cardId: `soak-insp-${nextInspIdx}`, toColumn: 'done', actor: 'soak' },
        }),
      );
      assert.equal(moveCardRes.ok, true, `Failed moving soak inspection card (${moveCardRes.status})`);
      inspectionsDone.push(res);
    }

    // 3. Periodic multi-card feature waves + concurrent read-only /plan check (every ~22 minutes)
    const waveTargetCount = Math.min(4, Math.floor((elapsedMs / TARGET_MS) * 4) + 1);
    const initialWaveOffsetMs = Math.min(90_000, Math.round(TARGET_MS * 0.1));
    if (featureWavesDone.length < waveTargetCount && elapsedMs >= featureWavesDone.length * (TARGET_MS / 4) + initialWaveOffsetMs) {
      const wave = await runFeatureWave(featureWavesDone.length + 1, fwToken);
      recordBeat();
      totalUnknownCalls += wave.unknownCalls;
      assert.equal(wave.passed, true, `Soak feature wave ${wave.wave} failed`);
      featureWavesDone.push(wave);
      if (!concurrentPlanOk) {
        const planCheck = await withAsyncSuspendTracking(() =>
          httpJson(`http://127.0.0.1:${SOAK_PORT}/ns-board/api/cards`, {
            method: 'POST',
            body: { id: 'soak-plan-backlog', title: 'Concurrent /plan proposal', owner: 'planner' },
          }),
        );
        concurrentPlanOk = planCheck.status === 201;
      }
    }

    // 4. Mid-soak PTY & Browser CDP HITL surface checks (after >= 25% elapsed)
    if (!midSoakSurfaces && elapsedMs >= TARGET_MS * 0.25) {
      recordBeat();
      const midPtyPath = join(ROOT_DIR, '.local', 'e2e', 'mid-soak-pty.json');
      const midPtyPort = Number(process.env.NS_MID_PTY_PORT || (SOAK_PORT === 17436 ? 17437 : 17436));
      const midPtyFwPort = Number(process.env.NS_MID_PTY_FW_PORT || (SOAK_FW_PORT === 18794 ? 18793 : 18794));
      await withAsyncSuspendTracking(() =>
        execFileAsync(process.env.PYTHON_BIN || 'python3', [join(ROOT_DIR, 'test', 'terminal-pty.py')], {
          env: { ...process.env, PATH: childPath(), NS_PTY_PORT: String(midPtyPort), NS_PTY_FW_PORT: String(midPtyFwPort), NS_PTY_OUT_JSON: midPtyPath },
          encoding: 'utf8',
          timeout: 90_000,
        }),
      );
      recordBeat();
      const { stdout: cdpOut } = await withAsyncSuspendTracking(() =>
        execFileAsync(
          process.execPath,
          [join(ROOT_DIR, 'test', 'board-browser.mjs'), '--observe', '--port', String(SOAK_PORT), '--state-dir', SOAK_STATE_DIR],
          {
            env: { ...process.env, PATH: childPath() },
            encoding: 'utf8',
            timeout: 60_000,
          },
        ),
      );
      const ptyJson = JSON.parse(readFileSync(midPtyPath, 'utf8'));
      const cdpJson = JSON.parse(cdpOut);
      assert.equal(ptyJson.passed && cdpJson.passed, true);
      midSoakSurfaces = { passed: true, pty: ptyJson.checks, browser: cdpJson };
      recordBeat();
    }

    // 5. Mid-soak Daemon Shutdown + Restart Evidence Invariance (after >= 55% elapsed)
    if (!midSoakRestart && elapsedMs >= TARGET_MS * 0.55) {
      recordBeat();
      const beforeRes = await withAsyncSuspendTracking(() => httpJson(`http://127.0.0.1:${SOAK_PORT}/ns-board/api/state`));
      assert.equal(beforeRes.ok && Array.isArray(beforeRes.json?.cards), true, `Failed querying board before restart (${beforeRes.status})`);
      const beforeBoard = beforeRes.json;
      await withAsyncSuspendTracking(() =>
        execFileAsync(process.execPath, [CLI_BIN, 'shutdown', '--state-dir', SOAK_STATE_DIR], { env: SOAK_ENV, timeout: 30_000 }),
      );
      recordBeat();
      const { stdout: restartedOut } = await withAsyncSuspendTracking(() =>
        execFileAsync(
          process.execPath,
          [CLI_BIN, 'start', '--port', String(SOAK_PORT), '--forewisp-port', String(SOAK_FW_PORT), '--state-dir', SOAK_STATE_DIR],
          { encoding: 'utf8', env: SOAK_ENV, timeout: 45_000 },
        ),
      );
      const restarted = JSON.parse(restartedOut);
      assert.equal(restarted.ok && restarted.forewispRunning, true);
      const afterRes = await withAsyncSuspendTracking(() => httpJson(`http://127.0.0.1:${SOAK_PORT}/ns-board/api/state`));
      assert.equal(afterRes.ok && Array.isArray(afterRes.json?.cards), true, `Failed querying board after restart (${afterRes.status})`);
      const afterBoard = afterRes.json;
      assert.equal(afterBoard.cards.length, beforeBoard.cards.length, 'Board card count changed across restart');
      midSoakRestart = { passed: true, cardCountPreserved: afterBoard.cards.length, panePidAfterRestart: restarted.panePid };
      recordBeat();
    }

    const beatNow = recordBeat();
    atomicJson(HEARTBEAT_PATH, {
      startedAt: new Date(startedAt).toISOString(),
      lastHeartbeatAt: new Date(beatNow).toISOString(),
      elapsedMs: beatNow - startedAt - osSuspendedMs,
      wallElapsedMs: beatNow - startedAt,
      osSuspendedMs,
      osSuspendCount: osSuspendEvents.length,
      networkOutageMs,
      networkOutageCount: networkOutageEvents.length,
      targetMs: TARGET_MS,
      cycles,
      rssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
      maxStallGapMs,
      totalUnknownCalls,
      jevSpentMicrodollars: budget.charged_microdollars,
      boardCounts: boardSt.json?.counts ?? {},
      inspectionsCompleted: inspectionsDone.length,
      featureWavesCompleted: featureWavesDone.length,
      concurrentPlanOk,
      midSoakSurfaces: Boolean(midSoakSurfaces?.passed),
      midSoakRestart: Boolean(midSoakRestart?.passed),
    });

    const remaining = TARGET_MS - (Date.now() - startedAt - osSuspendedMs);
    if (remaining <= 0 && !milestonesIncomplete()) break;
    const pollSleepMs = Math.min(30_000, Math.max(2_000, Math.round(TARGET_MS / 40)));
    const sleepDurationMs = remaining > 0 ? Math.min(pollSleepMs, remaining) : 2_000;
    const sleepStartedAt = Date.now();
    await delay(sleepDurationMs);
    const sleepWallMs = Date.now() - sleepStartedAt;
    if (sleepWallMs > sleepDurationMs + 5_000) {
      const suspendDelta = sleepWallMs - sleepDurationMs;
      osSuspendedMs += suspendDelta;
      lastBeat += suspendDelta;
      osSuspendEvents.push({ resumedAt: new Date().toISOString(), suspendMs: suspendDelta });
    }
  }

  const finalWallElapsed = Date.now() - startedAt;
  const finalElapsed = finalWallElapsed - osSuspendedMs;
  const finalBudget = readBudget();
  const report = {
    gate: 'gate7-continuous-soak',
    generatedAt: new Date().toISOString(),
    targetHours: TARGET_HOURS,
    elapsedMs: finalElapsed,
    wallElapsedMs: finalWallElapsed,
    osSuspendedMs,
    osSuspendCount: osSuspendEvents.length,
    osSuspendEvents,
    networkOutageMs,
    networkOutageCount: networkOutageEvents.length,
    networkOutageEvents,
    targetMs: TARGET_MS,
    cycles,
    maxStallGapMs,
    maxChildRunGapMs,
    totalUnknownCalls,
    jevBudget: finalBudget,
    inspections: inspectionsDone,
    featureWaves: featureWavesDone,
    faults: faultsReport,
    concurrentPlanOk,
    midSoakSurfaces,
    midSoakRestart,
    passed:
      finalElapsed >= TARGET_MS &&
      maxStallGapMs <= 120_000 &&
      maxChildRunGapMs <= 380_000 &&
      totalUnknownCalls === 0 &&
      inspectionsDone.length === INSPECTIONS.length &&
      inspectionsDone.every((x) => x.passed && x.dirtyUnchanged) &&
      featureWavesDone.length >= 1 &&
      featureWavesDone.every((x) => x.passed) &&
      Boolean(faultsReport?.passed) &&
      concurrentPlanOk &&
      Boolean(midSoakSurfaces?.passed) &&
      Boolean(midSoakRestart?.passed),
  };
  atomicJson(OUTPUT_PATH, report);
  console.log(JSON.stringify({ passed: report.passed, elapsedMs: report.elapsedMs, inspections: inspectionsDone.length, cycles }));
  if (!report.passed) process.exitCode = 1;
} finally {
  shutdownSoakSync();
}
