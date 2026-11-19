#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { childPath, readJevBudgetLedger, spawnIsolatedForewispJev, stopChildProcessGroup } from './_shared.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_BIN = join(ROOT_DIR, 'node_modules', '.bin', 'dsh');
const FOREWISP_BIN = join(ROOT_DIR, '.local', 'forewisp-target', 'release', 'forewisp');
const BUDGET_DB = join(ROOT_DIR, '.local', 'e2e', 'jev-budget.sqlite');
const OUTPUT_PATH = join(ROOT_DIR, '.local', 'e2e', 'gate2-routes.json');
const FORE_PORT = Number(process.env.NS_QUALIFY_FW_PORT || 18797);

const ROUTES = [
  { id: 'agy-hydrogen-low', provider: 'google-antigravity', model: 'antigravity-gemini-4-hydrogen', effort: 'low' },
  { id: 'agy-hydrogen-high', provider: 'google-antigravity', model: 'antigravity-gemini-4-hydrogen', effort: 'high' },
  { id: 'codex-luna-low', provider: 'openai-codex', model: 'gpt-6-luna', effort: 'low' },
  { id: 'codex-terra-high', provider: 'openai-codex', model: 'gpt-6.1-terra', effort: 'high' },
];

async function qualifyForewispJev() {
  const fw = await spawnIsolatedForewispJev({
    rootDir: ROOT_DIR,
    forewispBin: FOREWISP_BIN,
    port: FORE_PORT,
    workPrefix: 'ns-gate2-fw-',
    dbName: 'gate2-corpus.sqlite',
    budgetDbPath: BUDGET_DB,
  });

  try {
    const before = readJevBudgetLedger(FOREWISP_BIN, fw.realBudgetDb);
    assert.equal(before.blocked, false, 'Shared JEV budget must not be blocked');

    const headers = { authorization: `Bearer ${fw.apiToken}`, 'content-type': 'application/json' };
    const contrib = await fetch(`${fw.foreUrl}/v1/contributions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'memory',
        title: 'Gate 2 JEV qualification check',
        content: 'Use crypto.timingSafeEqual on SHA-256 token digests.',
        scope: 'private',
        applicability: 'timingSafeEqual token digest bearer auth',
        source: 'ns-dsh://gate2',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(contrib.status, 200);

    const recallRes = await fetch(`${fw.foreUrl}/v1/recall`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'Fix timing attack in bearer token digest comparison', kinds: ['memory'] }),
      signal: AbortSignal.timeout(25_000),
    });
    assert.equal(recallRes.status, 200);
    const recallJson = await recallRes.json();
    const after = readJevBudgetLedger(FOREWISP_BIN, fw.realBudgetDb);
    assert.equal(after.blocked, false, 'Shared JEV budget must remain unblocked');

    return {
      passed: Array.isArray(recallJson.entries) && !after.blocked,
      strategy: 'jev',
      modelHint: 'jev-1.13.0',
      recalledEntries: recallJson.entries?.length ?? 0,
      budgetBefore: before,
      budgetAfter: after,
    };
  } finally {
    await fw.close();
  }
}

async function qualifyModelRoutes() {
  const workDir = mkdtempSync(join(tmpdir(), 'ns-gate2-routes-'));
  const patchFile = join(workDir, 'patch.json');
  const resultFile = join(workDir, 'result.json');
  writeFileSync(
    patchFile,
    JSON.stringify(
      [
        { id: 'credentials', disabled: false },
        { id: 'authorization', disabled: false },
        { id: 'session-title-llm', disabled: true },
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'openai-codex': {},
            },
          },
        },
        {
          insert: [
            {
              id: 'qualify-probe',
              name: join(ROOT_DIR, 'eval', 'qualify-plugin.mjs'),
              config: { resultFile, routes: ROUTES },
            },
          ],
        },
      ],
      null,
      2,
    ),
    'utf8',
  );

  const child = spawn(
    DSH_BIN,
    ['--profile', 'web', '--patch', patchFile, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    {
      cwd: workDir,
      env: { ...process.env, PATH: childPath() },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    },
  );
  let stderrTail = '';
  child.stderr?.on('data', (d) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-2000);
  });

  try {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (existsSync(resultFile)) {
        const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
        await stopChildProcessGroup(child, true);
        return parsed;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`dsh qualify process exited early (${child.exitCode ?? child.signalCode}): ${stderrTail}`);
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for qualification result: ${stderrTail}`);
  } finally {
    await stopChildProcessGroup(child, true);
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    } catch {
      /* best-effort temp dir cleanup */
    }
  }
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const [jevResult, routesResult] = await Promise.allSettled([qualifyForewispJev(), qualifyModelRoutes()]);
const rejected = [jevResult, routesResult].filter((r) => r.status === 'rejected').map((r) => r.reason);
if (rejected.length === 1) {
  throw rejected[0];
}
if (rejected.length > 1) {
  throw new AggregateError(rejected, 'Gate 2 live qualification failed');
}
const forewispJev = jevResult.value;
const routesReport = routesResult.value;
const report = {
  gate: 'gate2-live-qualification',
  generatedAt: new Date().toISOString(),
  passed: Boolean(forewispJev.passed && routesReport.passed),
  forewispJev,
  routes: routesReport.routes,
};
writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) {
  process.exit(1);
}
