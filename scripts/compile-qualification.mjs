#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJevBudgetLedger } from '../eval/_shared.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = join(ROOT_DIR, '.local', 'e2e');
const FOREWISP_BIN = join(ROOT_DIR, '.local', 'forewisp-target', 'release', 'forewisp');
const BUDGET_DB = join(E2E_DIR, 'jev-budget.sqlite');

function resolveOutPath() {
  const idx = process.argv.indexOf('--out');
  if (idx >= 0) {
    const val = process.argv[idx + 1]?.trim();
    if (!val || val.startsWith('-')) {
      throw new Error('--out requires a non-empty file path');
    }
    return resolve(val);
  }
  if (process.env.NS_QUALIFICATION_OUT_PATH?.trim()) {
    return resolve(process.env.NS_QUALIFICATION_OUT_PATH.trim());
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return join(ROOT_DIR, 'evidence', `qualification-${stamp}.json`);
}

function readJsonRequired(path, label) {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Missing or unreadable required qualification artifact (${label}): ${path}`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed JSON in qualification artifact (${label}): ${path}`, { cause: err });
  }
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `Expected JSON object in ${label}: ${path}`);
  return parsed;
}

function readTrustedTextFileOptional(filePath) {
  let lst;
  try {
    lst = lstatSync(filePath);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  if (lst.isSymbolicLink() || !lst.isFile() || (typeof process.getuid === 'function' && lst.uid !== process.getuid())) {
    throw new Error(`Refusing untrusted file or symlink: ${filePath}`);
  }
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw new Error(`Refusing untrusted file: ${filePath}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function unquoteValue(rawVal) {
  const trimmed = rawVal.trim();
  if (!trimmed || trimmed.startsWith('#')) return '';
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    let escaped = false;
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && quote === '"') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        const trailing = trimmed.slice(i + 1).trim();
        if (!trailing || trailing.startsWith('#')) {
          return trimmed.slice(1, i);
        }
        break;
      }
    }
  }
  return trimmed.split(/\s+#/, 1)[0].trim();
}

function isSecretKeyName(key) {
  return /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|ACCESS|REFRESH|BEARER|OAUTH|SESSION)/i.test(key);
}

function isBenignUrlOrLiteral(val) {
  if (/^https?:\/\/[^@?]+$/i.test(val)) return true;
  if (/^(?:true|false|null|none|low|medium|high)$/i.test(val)) return true;
  return false;
}

function collectSecretSubstrings() {
  const secrets = [];
  const envFile = process.env.NS_FOREWISP_ENV_FILE || resolve(ROOT_DIR, '..', 'forewisp', '.env');
  const rawEnv = readTrustedTextFileOptional(envFile);
  if (rawEnv !== null) {
    for (const rawLine of rawEnv.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const cleaned = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const eq = cleaned.indexOf('=');
      if (eq <= 0) continue;
      const key = cleaned.slice(0, eq).trim();
      const val = unquoteValue(cleaned.slice(eq + 1));
      if (isSecretKeyName(key) && val.length >= 8 && !isBenignUrlOrLiteral(val)) {
        secrets.push(val);
      }
    }
  }

  const credFile = join(homedir(), '.dsh', '.credentials.yaml');
  const rawCred = readTrustedTextFileOptional(credFile);
  if (rawCred !== null) {
    for (const rawLine of rawCred.split(/\r?\n/)) {
      const m = rawLine.match(/^\s*[^#\s][^:]*:\s*(.+)$/);
      if (!m) continue;
      const key = rawLine.slice(0, rawLine.indexOf(':')).trim().toLowerCase();
      if (!isSecretKeyName(key)) continue;
      const val = unquoteValue(m[1]);
      if (val.length >= 8 && !isBenignUrlOrLiteral(val)) {
        secrets.push(val);
      }
    }
  }

  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length < 8) continue;
    if (isSecretKeyName(k) && !isBenignUrlOrLiteral(trimmed)) {
      secrets.push(trimmed);
    }
  }

  return [...new Set(secrets)];
}

const OUT_PATH = resolveOutPath();
const pkg = readJsonRequired(join(ROOT_DIR, 'package.json'), 'package.json');
const rawDshDep = pkg.dependencies?.['@deepseek-ai/dsh'] ?? pkg.devDependencies?.['@deepseek-ai/dsh'] ?? pkg.engines?.dsh ?? 'unknown';
const dshVersion = typeof rawDshDep === 'string' && rawDshDep.trim() ? rawDshDep.trim() : 'unknown';

const g1Coverage = readJsonRequired(join(E2E_DIR, 'gate1-coverage.json'), 'Gate 1 Coverage');
const g2Routes = readJsonRequired(join(E2E_DIR, 'gate2-routes.json'), 'Gate 2 Routes');
const g4RoleMatrix = readJsonRequired(join(E2E_DIR, 'gate4-role-matrix.json'), 'Gate 4 Role Matrix');
const g5Matched = readJsonRequired(join(E2E_DIR, 'gate5-matched.json'), 'Gate 5 Matched Comparison');
const g6Pty = readJsonRequired(join(E2E_DIR, 'gate6-terminal-pty.json'), 'Gate 6A Terminal PTY');
const g6Browser = readJsonRequired(join(E2E_DIR, 'gate6-board-browser.json'), 'Gate 6B Board Browser CDP');
const g7Github = readJsonRequired(join(E2E_DIR, 'gate7-github-issue.json'), 'Gate 7A GitHub Issue E2E');
const g7Soak = readJsonRequired(join(E2E_DIR, 'gate7-soak.json'), 'Gate 7B 2-Hour Soak');
const g8Rollback = readJsonRequired(join(E2E_DIR, 'gate8-rollback-ledger.json'), 'Gate 8 Rollback & JEV Cap');

assert.ok(Array.isArray(g2Routes.routes), 'Gate 2 routes artifact must contain routes[] array');
assert.ok(Array.isArray(g4RoleMatrix.runs), 'Gate 4 role-matrix artifact must contain runs[] array');

const budgetFinal = readJevBudgetLedger(FOREWISP_BIN, BUDGET_DB);

const gates = {
  gate1_tests_and_coverage: {
    passed: Boolean(g1Coverage.passed),
    linesPct: g1Coverage.lines?.pct,
    linesCovered: g1Coverage.lines?.covered,
    linesTotal: g1Coverage.lines?.total,
  },
  gate2_live_routes_and_jev: {
    passed: Boolean(g2Routes.passed),
    forewispStrategy: g2Routes.forewispJev?.strategy,
    routes: g2Routes.routes.map((r) => ({ id: r.id, provider: r.provider, model: r.model, passed: r.passed, stages: r.stages, cancelMs: r.cancelMs })),
  },
  gate3_and_4_role_matrix: {
    passed: Boolean(g4RoleMatrix.passed),
    totalRuns: g4RoleMatrix.totalRuns,
    passedCount: g4RoleMatrix.passedCount,
    unknownCalls: g4RoleMatrix.runs.reduce((a, b) => a + (b.unknownCalls || 0), 0),
  },
  gate5_frozen_matched_comparison: {
    passed: Boolean(g5Matched.passed),
    freezeHash: g5Matched.freezeHash,
    totalRuns: g5Matched.totalRuns,
    byArm: g5Matched.byArm,
  },
  gate6_terminal_and_browser_hitl: {
    passed: Boolean(g6Pty.passed && g6Browser.passed && g6Browser.boardPageVerified && g6Browser.consoleErrors === 0 && g6Browser.pageErrors === 0),
    pty: g6Pty.checks,
    browserCdp: {
      cdpPort: g6Browser.cdpPort,
      boardPageVerified: Boolean(g6Browser.boardPageVerified),
      consoleErrors: g6Browser.consoleErrors,
      pageErrors: g6Browser.pageErrors,
      sseAutoUnblockRevision: g6Browser.sseAutoUnblockRevision,
      unmetDependencyStatus: g6Browser.unmetDependencyStatus,
      staleCasStatus: g6Browser.staleCasStatus,
      crossOriginStatus: g6Browser.crossOriginStatus,
      tuiUnauthAttachStatus: g6Browser.tuiUnauthAttachStatus,
    },
  },
  gate7_github_and_continuous_soak: {
    passed: Boolean(g7Github.passed && g7Soak.passed),
    githubIssue: {
      repository: g7Github.repository,
      issueNumber: g7Github.issueNumber,
      issueUrl: g7Github.issueUrl,
      ocrPassed: g7Github.ocrPassed,
      crossFamilyReviewPassed: g7Github.crossFamilyReviewPassed,
    },
    soak: {
      targetHours: g7Soak.targetHours,
      elapsedMs: g7Soak.elapsedMs,
      wallElapsedMs: g7Soak.wallElapsedMs ?? g7Soak.elapsedMs,
      osSuspendedMs: g7Soak.osSuspendedMs ?? 0,
      osSuspendCount: g7Soak.osSuspendCount ?? 0,
      networkOutageMs: g7Soak.networkOutageMs ?? 0,
      networkOutageCount: g7Soak.networkOutageCount ?? 0,
      cycles: g7Soak.cycles,
      maxStallGapMs: g7Soak.maxStallGapMs,
      totalUnknownCalls: g7Soak.totalUnknownCalls,
      inspectionsCompleted: g7Soak.inspections?.length,
      featureWavesCompleted: g7Soak.featureWaves?.length,
      faultsPassed: g7Soak.faults?.passed,
      midSoakSurfacesPassed: g7Soak.midSoakSurfaces?.passed,
      midSoakRestartPassed: g7Soak.midSoakRestart?.passed,
    },
  },
  gate8_synthetic_cap_and_rollback: {
    passed: Boolean(g8Rollback.passed),
    syntheticCap: g8Rollback.syntheticCap,
    rollbackPreservation: g8Rollback.rollbackPreservation,
  },
};

const allPassed = Object.values(gates).every((g) => g.passed === true) && budgetFinal.blocked === false;

const bundle = {
  schema: 'ns-dsh.qualification.v1',
  generatedAt: new Date().toISOString(),
  allGatesPassed: allPassed,
  dshVersion,
  sharedJevBudgetLedger: budgetFinal,
  gates,
};

const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
const homeDir = homedir();
if (homeDir.length > 1) {
  const escapedHome = JSON.stringify(homeDir).slice(1, -1);
  assert.equal(serialized.includes(homeDir), false, 'Bundle must not leak home directory path');
  if (escapedHome) {
    assert.equal(serialized.includes(escapedHome), false, 'Bundle must not leak escaped home directory path');
  }
}
for (const secret of collectSecretSubstrings()) {
  const escapedSecret = JSON.stringify(secret).slice(1, -1);
  assert.equal(serialized.includes(secret), false, 'Refusing to write qualification bundle containing raw secret substring');
  if (escapedSecret) {
    assert.equal(serialized.includes(escapedSecret), false, 'Refusing to write qualification bundle containing escaped secret substring');
  }
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
const tmpOut = `${OUT_PATH}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
try {
  writeFileSync(tmpOut, serialized, { mode: 0o600, flag: 'wx' });
  chmodSync(tmpOut, 0o600);
  renameSync(tmpOut, OUT_PATH);
  chmodSync(OUT_PATH, 0o600);
} finally {
  rmSync(tmpOut, { force: true });
}
console.log(JSON.stringify({ wrote: OUT_PATH, allGatesPassed: allPassed }, null, 2));
if (!allPassed) process.exit(1);
