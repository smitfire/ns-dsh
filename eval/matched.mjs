#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupCleanroomAgyHome,
  prepareCleanroomAgyHome,
  prepareIsolatedBaselineDshHome,
  runAgyCleanroom,
  runDshHeadless,
} from '../bench/cleanroom-compare.mjs';
import { KanbanStore } from '../plugins/board/dist/core/index.js';
import { verifySnapshotTests } from '../plugins/team/dist/core/index.js';
import { createGitFixtureRepo, spawnIsolatedForewispJev } from './_shared.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_NATIVE_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const FOREWISP_BIN = join(ROOT_DIR, '.local', 'forewisp-target', 'release', 'forewisp');
const FREEZE_PATH = join(ROOT_DIR, '.local', 'e2e', 'matched-freeze.json');
const OUTPUT_PATH = join(ROOT_DIR, '.local', 'e2e', 'gate5-matched.json');
const FORE_PORT = Number(process.env.NS_MATCHED_FW_PORT || 18798);
const BUDGET_DB = process.env.NS_JEV_BUDGET_DB || join(ROOT_DIR, '.local', 'e2e', 'jev-budget.sqlite');
assert.ok(Number.isInteger(FORE_PORT) && FORE_PORT >= 1 && FORE_PORT <= 65535, `Invalid NS_MATCHED_FW_PORT: ${FORE_PORT}`);
const IMMUTABLE_WORKLOAD_FILES = {
  'heldout-1-config-audit': ['src/defaults.mjs', 'src/env.mjs', 'src/resolve.mjs'],
  'heldout-3-dag-topo': ['src/runner.mjs'],
  'heldout-4-log-forensics': ['logs/incident.log'],
};

const ARMS = [
  'cleanroom-agy-flash',
  'cleanroom-agy-orchestrator',
  'factory-dsh',
  'ns-dsh-switchyard-reactive',
  'ns-dsh-orchestrator',
  'ns-dsh-orchestrator-forewisp',
];

function sha256(obj) {
  return createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex');
}

function sourceIdentity() {
  const parts = [
    readFileSync(join(ROOT_DIR, 'eval', 'matched.mjs'), 'utf8'),
    readFileSync(join(ROOT_DIR, 'eval', '_shared.mjs'), 'utf8'),
    readFileSync(join(ROOT_DIR, 'bench', 'cleanroom-compare.mjs'), 'utf8'),
    readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'),
  ];
  return sha256(parts.join('\n---SOURCE-SEP---\n'));
}

function buildHeldoutWorkloads() {
  const pkg = JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test/acceptance.test.mjs' } });
  const wrapTest = (imports, body) =>
    `${imports}\nimport assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('heldout-acceptance', async () => {\n${body}\n});\n`;

  const incidentLog = Array.from({ length: 3000 }, (_, i) =>
    i === 2147
      ? '2026-11-16T15:22:10Z ERROR EPOCH_HEADER_REJECTED at src/correlate.mjs:14 (code=E_EPOCH_773)'
      : `2026-11-16T15:22:10Z INFO span=${i} status=200 route=/v1/ingest`,
  ).join('\n');

  return [
    {
      id: 'heldout-1-config-audit',
      files: {
        'package.json': pkg,
        'src/defaults.mjs': "export const DEFAULTS = { QUEUE_BURST_CAP: 48, WORKER_CONCURRENCY: 4 };\n",
        'src/env.mjs': "export const ENV_OVERRIDES = { QUEUE_BURST_CAP: 96 };\n",
        'src/resolve.mjs': "import { DEFAULTS } from './defaults.mjs';\nimport { ENV_OVERRIDES } from './env.mjs';\nexport const effective = (k) => ENV_OVERRIDES[k] ?? DEFAULTS[k];\n",
        'test/acceptance.test.mjs': wrapTest(
          "import { readFileSync } from 'node:fs';",
          "const rep = JSON.parse(readFileSync('audit.json', 'utf8'));\nassert.deepEqual(rep, { owner: 'src/env.mjs', key: 'QUEUE_BURST_CAP', effectiveDefault: 96 });",
        ),
      },
      prompt: 'Audit src/defaults.mjs, src/env.mjs, and src/resolve.mjs WITHOUT modifying any file under src/. Do not modify package.json or test/acceptance.test.mjs. Write audit.json with {"owner":"src/env.mjs","key":"QUEUE_BURST_CAP","effectiveDefault":96} and run node --test test/acceptance.test.mjs.',
    },
    {
      id: 'heldout-2-token-bucket',
      files: {
        'package.json': pkg,
        'src/limiter.mjs':
          'export function createBucket(capacity, ratePerMs) {\n  let tokens = capacity;\n  let last = 0;\n  return function take(nowMs) {\n    const elapsed = nowMs - last;\n    tokens = tokens + elapsed * ratePerMs;\n    last = nowMs;\n    if (tokens >= 1) { tokens -= 1; return { allowed: true, remaining: tokens }; }\n    return { allowed: false, remaining: tokens };\n  };\n}\n',
        'test/acceptance.test.mjs': wrapTest(
          "import { createBucket } from '../src/limiter.mjs';",
          'const b = createBucket(3, 0.5);\nassert.equal(b(1000).remaining, 2);\nassert.equal(b(900).allowed, true);\nassert.equal(b(900).remaining <= 2, true);\nfor (let i = 0; i < 5; i += 1) b(901);\nassert.equal(b(901).allowed, false);\nassert.equal(b(10_000).remaining <= 2, true);',
        ),
      },
      prompt: 'Fix the token bucket refill clamping bug and backward-clock (negative elapsed time) bug in src/limiter.mjs: never let elapsed go below 0, clamp tokens to at most capacity before consuming, and only update last = Math.max(last, nowMs). Do not touch tests or package.json. Run node --test test/acceptance.test.mjs.',
    },
    {
      id: 'heldout-3-dag-topo',
      files: {
        'package.json': pkg,
        'src/topo.mjs': 'export function topoSort(nodes, edges) { return [...nodes]; }\n',
        'src/runner.mjs':
          "import { topoSort } from './topo.mjs';\nexport const planOrder = (nodes, edges) => topoSort(nodes, edges);\n",
        'test/acceptance.test.mjs': wrapTest(
          "import { planOrder } from '../src/runner.mjs';",
          "assert.deepEqual(planOrder(['b', 'a', 'c'], [['c', 'b'], ['a', 'b']]), ['a', 'c', 'b']);\nassert.throws(() => planOrder(['x', 'y'], [['x', 'y'], ['y', 'x']]), /cycle/i);",
        ),
      },
      prompt: 'Implement deterministic Kahn topological sort in src/topo.mjs where edges are [prerequisite, dependent] pairs: emit ready nodes in ascending lexicographic order and throw an Error containing "cycle" if any cycle exists. Preserve src/runner.mjs, package.json, and test/acceptance.test.mjs. Run node --test test/acceptance.test.mjs.',
    },
    {
      id: 'heldout-4-log-forensics',
      files: {
        'package.json': pkg,
        'logs/incident.log': incidentLog,
        'src/correlate.mjs': 'export function correlationEpoch(headers) { return headers["X-Correlation-Epoch"]; }\n',
        'test/acceptance.test.mjs': wrapTest(
          "import { readFileSync } from 'node:fs';\nimport { correlationEpoch } from '../src/correlate.mjs';",
          "assert.equal(correlationEpoch({ 'X-Correlation-Epoch': '  E7  ' }), 'e7');\nassert.equal(correlationEpoch({ 'x-correlation-epoch': 'E9' }), 'e9');\nassert.equal(correlationEpoch({}), 'e0');\nconst f = JSON.parse(readFileSync('forensics.json', 'utf8'));\nassert.equal(f.code, 'E_EPOCH_773');\nassert.equal(f.location, 'src/correlate.mjs:14');",
        ),
      },
      prompt: 'Inspect logs/incident.log to extract the ERROR code (E_...) and file:line location into forensics.json ({"code":...,"location":...}). Also fix correlationEpoch(headers) in src/correlate.mjs so X-Correlation-Epoch is matched case-insensitively, trimmed, lowercased, and defaults to "e0". Do not modify package.json or test/acceptance.test.mjs. Run node --test test/acceptance.test.mjs.',
    },
    {
      id: 'heldout-5-coupled-recovery',
      files: {
        'package.json': pkg,
        'src/schema.mjs':
          'export function validateSpec(spec) {\n  return { id: spec.id, priority: spec.priority, weight: spec.weight, retries: spec.retries };\n}\n',
        'src/pipeline.mjs':
          "import { validateSpec } from './schema.mjs';\nexport function buildPlan(items) {\n  const ordered = items.map((item) => validateSpec(item));\n  return { ordered, totalWeight: 0 };\n}\n",
        'src/index.mjs':
          "import { buildPlan } from './pipeline.mjs';\nexport function scheduleRoutes(routes) {\n  return buildPlan(routes);\n}\n",
        'test/acceptance.test.mjs': wrapTest(
          "import { scheduleRoutes } from '../src/index.mjs';",
          "const rawInput = [\n  { id: '  Beta ', priority: 2, weight: 1.5, retries: 1 },\n  { id: ' alpha', priority: 2, weight: 2.5, retries: 0 },\n  { id: 'Gamma ', priority: 5, weight: 3, retries: 2 },\n];\nconst snapshotCopy = structuredClone(rawInput);\nconst out = scheduleRoutes(rawInput);\nassert.deepEqual(rawInput, snapshotCopy);\nassert.deepEqual(\n  out.ordered.map((r) => ({ id: r.id, priority: r.priority, weight: r.weight, retries: r.retries })),\n  [\n    { id: 'gamma', priority: 5, weight: 3, retries: 2 },\n    { id: 'alpha', priority: 2, weight: 2.5, retries: 0 },\n    { id: 'beta', priority: 2, weight: 1.5, retries: 1 },\n  ],\n);\nassert.equal(out.totalWeight, 7);\nassert.throws(() => scheduleRoutes([{ id: 'x', priority: 1, weight: NaN, retries: 0 }]), Error);\nassert.throws(() => scheduleRoutes([{ id: 'x', priority: 1, weight: Infinity, retries: 0 }]), Error);\nassert.throws(() => scheduleRoutes([{ id: 'x', priority: 1, weight: -1, retries: 0 }]), Error);\nassert.throws(() => scheduleRoutes([{ id: 'x', priority: 1, weight: 1, retries: -1 }]), Error);\nassert.throws(() => scheduleRoutes([{ id: 'x', priority: 1, weight: 1, retries: 1.5 }]), Error);\nassert.throws(() => scheduleRoutes([{ id: '   ', priority: 1, weight: 1, retries: 0 }]), Error);",
        ),
      },
      prompt: 'Fix the multi-module scheduling pipeline across src/schema.mjs, src/pipeline.mjs, and src/index.mjs without modifying tests or package.json: never mutate caller inputs, validateSpec(spec) must trim and lowercase string id (throwing Error if non-string or empty), validate finite priority, finite non-negative weight, and non-negative integer retries (throwing Error on invalid inputs), and buildPlan/scheduleRoutes must sort ordered entries by priority descending then normalized id ascending and compute exact totalWeight sum. Run node --test test/acceptance.test.mjs.',
    },
  ];
}

function freezePayload() {
  const workloads = buildHeldoutWorkloads();
  return {
    schema: 'ns-dsh.matched-freeze.v1',
    frozenAt: new Date().toISOString(),
    matchedRoute: {
      agyModel: 'gemini-4-hydrogen-low',
      agyOrchestratorModel: 'gemini-pro-orchestrator',
      dshProvider: 'google-antigravity',
      dshModel: 'antigravity-gemini-4-hydrogen',
      dshCapableEffort: 'high',
      effort: 'low',
    },
    arms: ARMS,
    sourceIdentity: sourceIdentity(),
    workloadsHash: sha256(workloads),
    payloadHash: sha256({ arms: ARMS, source: sourceIdentity(), workloads }),
  };
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function countRawToolCalls(raw) {
  const combined = (raw.directToolCalls ?? 0) + (raw.ptcToolCalls ?? 0);
  if (combined > 0) return combined;
  if (typeof raw.toolCalls === 'number' && raw.toolCalls > 0) return raw.toolCalls;
  return 0;
}

function readKanbanAudit(repoDir) {
  const dbPath = join(repoDir, '.ns-dsh', 'board.db');
  if (!existsSync(dbPath)) return null;
  const store = new KanbanStore(dbPath);
  try {
    const snap = store.snapshot();
    const tiers = { efficient: 0, capable: 0, unset: 0 };
    let doneCount = 0;
    for (const card of snap.cards) {
      if (card.column === 'done') doneCount += 1;
      if (card.modelTier === 'capable') tiers.capable += 1;
      else if (card.modelTier === 'efficient') tiers.efficient += 1;
      else tiers.unset += 1;
    }
    return { cardCount: snap.cards.length, doneCount, tiers };
  } finally {
    store.close();
  }
}

if (process.argv.includes('--freeze')) {
  mkdirSync(dirname(FREEZE_PATH), { recursive: true });
  const frozen = freezePayload();
  writeFileSync(FREEZE_PATH, `${JSON.stringify(frozen, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ frozen: true, freezePath: FREEZE_PATH, payloadHash: frozen.payloadHash }, null, 2));
  process.exit(0);
}

if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({ ready: true, freezeExists: existsSync(FREEZE_PATH), arms: ARMS, workloads: buildHeldoutWorkloads().map((w) => w.id) }, null, 2));
  process.exit(0);
}

if (!existsSync(FREEZE_PATH)) {
  throw new Error(`Freeze file missing at ${FREEZE_PATH}. Run with --freeze first.`);
}
const frozen = JSON.parse(readFileSync(FREEZE_PATH, 'utf8'));
const verifyFreeze = () => {
  const cur = freezePayload();
  if (cur.payloadHash !== frozen.payloadHash || cur.workloadsHash !== frozen.workloadsHash) {
    throw new Error('Held-out workloads or harness changed after freeze; aborting.');
  }
};
verifyFreeze();

if (process.argv.includes('--allow-keychain')) {
  process.env.NS_AGY_ALLOW_KEYCHAIN = '1';
}

let cleanAgy = null;
let factoryDshHome = null;
let fw = null;

try {
  cleanAgy = prepareCleanroomAgyHome();
  if (!cleanAgy.cleanroomVerified) {
    throw new Error('Cleanroom agy verification failed');
  }
  factoryDshHome = prepareIsolatedBaselineDshHome();
  fw = await spawnIsolatedForewispJev({
    rootDir: ROOT_DIR,
    forewispBin: FOREWISP_BIN,
    port: FORE_PORT,
    workPrefix: 'ns-gate5-fw-',
    dbName: 'gate5-corpus.sqlite',
    budgetDbPath: BUDGET_DB,
  });

  const seedRes = await fetch(`${fw.foreUrl}/v1/contributions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fw.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'memory',
      title: 'Heldout Correlation Epoch Convention',
      content: 'correlationEpoch(headers) matches X-Correlation-Epoch case-insensitively, trims, lowercases, and falls back to "e0".',
      scope: 'private',
      applicability: 'correlationEpoch X-Correlation-Epoch correlate.mjs e0',
      source: 'ns-dsh://gate5',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!seedRes.ok) {
    throw new Error(`Forewisp Gate 5 contribution seed failed (${seedRes.status})`);
  }

  const workloads = buildHeldoutWorkloads();
  const runs = [];

  for (let wi = 0; wi < workloads.length; wi += 1) {
    const workload = workloads[wi];
    const rotatedArms = [...ARMS.slice(wi % ARMS.length), ...ARMS.slice(0, wi % ARMS.length)];
    for (const arm of rotatedArms) {
      verifyFreeze();
      const repoDir = createGitFixtureRepo(`ns-g5-${workload.id}-${arm}-`, 'gate5@example.invalid', 'Gate5', workload.files);
      const immutableFiles = ['package.json', 'test/acceptance.test.mjs', ...(IMMUTABLE_WORKLOAD_FILES[workload.id] ?? [])];
      const immutableHashes = immutableFiles.map((rel) => sha256(workload.files[rel]));
      try {
        let raw;
        if (arm === 'cleanroom-agy-flash') {
          raw = runAgyCleanroom({ agyHome: cleanAgy.agyHome, cwd: repoDir, prompt: workload.prompt, model: 'gemini-4-hydrogen-low' });
        } else if (arm === 'cleanroom-agy-orchestrator') {
          raw = runAgyCleanroom({ agyHome: cleanAgy.agyHome, cwd: repoDir, prompt: workload.prompt, model: 'gemini-pro-orchestrator' });
        } else if (arm === 'factory-dsh') {
          raw = await runDshHeadless({
            dshHome: factoryDshHome,
            cwd: repoDir,
            prompt: workload.prompt,
            provider: 'google-antigravity',
            model: 'antigravity-gemini-4-hydrogen',
            reasoningEffort: 'low',
            label: 'factory-dsh',
            unsetEnvKeys: ['FOREWISP_URL', 'NS_FOREWISP_URL', 'FOREWISP_API_TOKEN', 'NS_BOARD_DB_PATH'],
          });
        } else if (arm === 'ns-dsh-switchyard-reactive') {
          raw = await runDshHeadless({
            dshHome: DSH_NATIVE_HOME,
            cwd: repoDir,
            prompt: workload.prompt,
            provider: 'google-antigravity',
            model: 'antigravity-gemini-4-hydrogen',
            reasoningEffort: 'low',
            ptcEnabled: true,
            teamStrategy: 'switchyard-stage',
            label: 'ns-dsh-switchyard-reactive',
            unsetEnvKeys: ['FOREWISP_URL', 'NS_FOREWISP_URL', 'FOREWISP_API_TOKEN', 'NS_BOARD_DB_PATH'],
          });
        } else if (arm === 'ns-dsh-orchestrator') {
          raw = await runDshHeadless({
            dshHome: DSH_NATIVE_HOME,
            cwd: repoDir,
            prompt: workload.prompt,
            provider: 'google-antigravity',
            model: 'antigravity-gemini-4-hydrogen',
            reasoningEffort: 'low',
            ptcEnabled: true,
            teamStrategy: 'orchestrator',
            label: 'ns-dsh-orchestrator',
            unsetEnvKeys: ['FOREWISP_URL', 'NS_FOREWISP_URL', 'FOREWISP_API_TOKEN', 'NS_BOARD_DB_PATH'],
          });
        } else {
          raw = await runDshHeadless({
            dshHome: DSH_NATIVE_HOME,
            cwd: repoDir,
            prompt: workload.prompt,
            provider: 'google-antigravity',
            model: 'antigravity-gemini-4-hydrogen',
            reasoningEffort: 'low',
            ptcEnabled: true,
            teamStrategy: 'orchestrator',
            label: 'ns-dsh-orchestrator-forewisp',
            unsetEnvKeys: ['NS_BOARD_DB_PATH'],
            extraEnv: { FOREWISP_URL: fw.foreUrl, NS_FOREWISP_URL: fw.foreUrl, FOREWISP_API_TOKEN: fw.apiToken },
          });
        }

        const snapshot = verifySnapshotTests(repoDir, 'node --test test/acceptance.test.mjs', { timeoutMs: 30_000 });
        const testsUnchanged = immutableFiles.every((rel, idx) => {
          const abs = join(repoDir, rel);
          return existsSync(abs) && sha256(readFileSync(abs, 'utf8')) === immutableHashes[idx];
        });
        const accepted = raw.exitCode === 0 && snapshot.passed && testsUnchanged && (raw.unknownCalls ?? 0) === 0;
        const kanbanAudit = readKanbanAudit(repoDir);

        const row = {
          key: `${workload.id}:${arm}`,
          workload: workload.id,
          arm,
          orderIndex: wi,
          accepted,
          exitCode: raw.exitCode,
          snapshotPassed: snapshot.passed,
          testsUnchanged,
          wallMs: raw.wallMs,
          bootMs: firstDefined(raw.bootMs, raw.bootOverheadMs),
          peakRssMb: firstDefined(raw.peakRssMb),
          steps: firstDefined(raw.steps, raw.turns, 1),
          toolCalls: countRawToolCalls(raw),
          step1PromptTokens: firstDefined(raw.step1PromptTokens, raw.inputTokens),
          uncachedInputTokens: raw.uncachedInputTokens ?? 0,
          cachedInputTokens: raw.cachedInputTokens ?? 0,
          outputTokens: raw.outputTokens ?? 0,
          thinkingTokens: raw.thinkingTokens ?? 0,
          orchestratorPlanHandoffs: raw.orchestratorPlanHandoffs ?? 0,
          orchestratorReplans: raw.orchestratorReplans ?? 0,
          switchyardEscalations: raw.switchyardEscalations ?? 0,
          modelBreakdown: raw.modelBreakdown ?? null,
          kanbanAudit,
          unknownCalls: raw.unknownCalls ?? 0,
        };
        runs.push(row);
        console.log(JSON.stringify(row));
      } catch (err) {
        const failedRow = {
          key: `${workload.id}:${arm}`,
          workload: workload.id,
          arm,
          orderIndex: wi,
          accepted: false,
          errored: true,
          exitCode: 1,
          snapshotPassed: false,
          testsUnchanged: false,
          error: err instanceof Error ? err.message : String(err),
          wallMs: null,
          bootMs: null,
          peakRssMb: null,
          steps: null,
          toolCalls: null,
          step1PromptTokens: null,
          uncachedInputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          thinkingTokens: null,
          orchestratorPlanHandoffs: 0,
          orchestratorReplans: 0,
          switchyardEscalations: 0,
          modelBreakdown: null,
          kanbanAudit: null,
          unknownCalls: 0,
        };
        runs.push(failedRow);
        console.log(JSON.stringify(failedRow));
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  }

  const byArm = {};
  for (const arm of ARMS) {
    const subset = runs.filter((r) => r.arm === arm);
    const valid = subset.filter((r) => !r.errored);
    const avg = (fn) => (valid.length ? Number((valid.reduce((a, b) => a + fn(b), 0) / valid.length).toFixed(1)) : 0);
    byArm[arm] = {
      runs: subset.length,
      errors: subset.filter((r) => r.errored).length,
      accepted: subset.filter((r) => r.accepted).length,
      avgWallMs: avg((r) => r.wallMs || 0),
      avgSteps: avg((r) => r.steps || 0),
      avgToolCalls: avg((r) => r.toolCalls || 0),
      avgUncachedInputTokens: avg((r) => r.uncachedInputTokens || 0),
      avgCachedInputTokens: avg((r) => r.cachedInputTokens || 0),
      avgOutputTokens: avg((r) => r.outputTokens || 0),
      avgThinkingTokens: avg((r) => r.thinkingTokens || 0),
      totalPlanHandoffs: subset.reduce((a, b) => a + (b.orchestratorPlanHandoffs || 0), 0),
      totalReplans: subset.reduce((a, b) => a + (b.orchestratorReplans || 0), 0),
      kanbanAuditedRuns: subset.filter((r) => r.kanbanAudit && r.kanbanAudit.cardCount > 0).length,
      totalUnknownCalls: subset.reduce((a, b) => a + b.unknownCalls, 0),
    };
  }

  const switchyardArm = byArm['ns-dsh-switchyard-reactive'];
  const orchArm = byArm['ns-dsh-orchestrator'];
  const orchFwArm = byArm['ns-dsh-orchestrator-forewisp'];
  const allUnknownZero = Object.values(byArm).every((a) => a.totalUnknownCalls === 0);
  const allRunsNoError = runs.every((r) => !r.errored);
  const report = {
    gate: 'gate5-matched-comparison',
    generatedAt: new Date().toISOString(),
    freezeHash: frozen.payloadHash,
    totalRuns: runs.length,
    passed:
      runs.length === workloads.length * ARMS.length &&
      allRunsNoError &&
      allUnknownZero &&
      switchyardArm.accepted === workloads.length &&
      orchArm.accepted === workloads.length &&
      orchArm.kanbanAuditedRuns >= Math.max(1, workloads.length - 1) &&
      orchFwArm.accepted === workloads.length &&
      orchFwArm.kanbanAuditedRuns >= Math.max(1, workloads.length - 1),
    byArm,
    runs,
  };
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (!report.passed) process.exitCode = 1;
} finally {
  if (cleanAgy?.agyHome) cleanupCleanroomAgyHome(cleanAgy.agyHome);
  if (factoryDshHome) rmSync(factoryDshHome, { recursive: true, force: true });
  if (fw) await fw.close();
}
