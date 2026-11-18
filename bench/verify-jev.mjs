#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOREWISP_REPO = process.env.FOREWISP_REPO || resolve(ROOT_DIR, '..', 'forewisp');
const FOREWISP_BIN =
  process.env.FOREWISP_BIN || join(ROOT_DIR, '.local', 'forewisp-target', 'release', 'forewisp');
const E2E_DIR = join(ROOT_DIR, '.local', 'e2e');
const BUDGET_DB = process.env.NS_JEV_BUDGET_DB || join(E2E_DIR, 'jev-verify-budget.sqlite');
const TEST_DB = join(E2E_DIR, 'forewisp-jev-verify.sqlite3');
const EVIDENCE_PATH = join(ROOT_DIR, 'evidence', 'jev-live-verification.json');
const PORT = Number(process.env.FOREWISP_VERIFY_PORT || 8797);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CEILING_MICRODOLLARS = 25_000_000;
const MAX_RUN_SPEND_MICRODOLLARS = Number(process.env.NS_JEV_MAX_RUN_SPEND_MICRODOLLARS || 500_000);
const EXPECTED_JEV_MODEL = process.env.JEV_EXPECTED_MODEL || 'jev-1.13.0';
const EXPECTED_JEV_ENDPOINT = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
const knownSecrets = new Set(process.env.TYPESAFE_API_KEY?.trim() ? [process.env.TYPESAFE_API_KEY.trim()] : []);

function parseTypesafeKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    const key = process.env.TYPESAFE_API_KEY.trim();
    knownSecrets.add(key);
    return key;
  }
  const dotenvPath = join(FOREWISP_REPO, '.env');
  if (!existsSync(dotenvPath)) {
    throw new Error(`Missing .env file at ${dotenvPath}; set TYPESAFE_API_KEY or FOREWISP_REPO`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const st = lstatSync(dotenvPath);
  if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
    throw new Error(`Refusing unsafe .env permissions or type: ${dotenvPath}`);
  }
  const fd = openSync(dotenvPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let raw = '';
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || (fst.mode & 0o077) !== 0 || (uid !== null && fst.uid !== uid)) {
      throw new Error(`Refusing unsafe .env permissions or type: ${dotenvPath}`);
    }
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = cleaned.indexOf('=');
    if (eq < 0) continue;
    if (cleaned.slice(0, eq).trim() !== 'TYPESAFE_API_KEY') continue;
    let v = cleaned.slice(eq + 1).trim();
    if (v.length >= 2 && v[0] === v.at(-1) && (v[0] === '"' || v[0] === "'")) {
      v = v.slice(1, -1);
    }
    if (v.trim()) {
      const key = v.trim();
      knownSecrets.add(key);
      return key;
    }
  }
  throw new Error('TYPESAFE_API_KEY not found in forewisp/.env or environment');
}

function execForewispCli(cliArgs) {
  const sanitizedEnv = { ...process.env };
  delete sanitizedEnv.TYPESAFE_API_KEY;
  try {
    return execFileSync(FOREWISP_BIN, cliArgs, {
      encoding: 'utf8',
      env: sanitizedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(raw, [...knownSecrets]), { cause: err });
  }
}

function buildMinimalChildEnv(extra = {}) {
  const out = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return Object.assign(out, extra);
}

function readBudgetStatus() {
  const out = execForewispCli(['budget-status', BUDGET_DB]);
  try {
    return JSON.parse(out.trim());
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid budget-status JSON: ${redactSecrets(raw, [...knownSecrets])}`, { cause: err });
  }
}

function redactSecrets(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s) out = out.replaceAll(s, '[REDACTED]');
  }
  return out;
}

function ensureBudgetLedger() {
  mkdirSync(E2E_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(BUDGET_DB)) {
    execForewispCli(['budget-init', BUDGET_DB, String(CEILING_MICRODOLLARS)]);
  }
  const status = readBudgetStatus();
  assert.equal(status.blocked, false, 'Shared JEV budget ledger must not be blocked');
  assert.equal(status.ceiling_microdollars, CEILING_MICRODOLLARS);
  assert.ok(
    status.ceiling_microdollars - status.charged_microdollars >= MAX_RUN_SPEND_MICRODOLLARS,
    `Insufficient JEV ledger headroom: remaining=${status.ceiling_microdollars - status.charged_microdollars}, need=${MAX_RUN_SPEND_MICRODOLLARS}`,
  );
  return status;
}

function runDirectPythonJevProbe(typesafeKey) {
  const script = `
import json, os
from pathlib import Path
from forewisp_runtime.jev_decision import JevDecisionClient

client = JevDecisionClient.from_environment(
    ledger_path=Path(os.environ["FOREWISP_BUDGET_DB"]),
    session_cap_microdollars=1_000_000,
    timeout_seconds=15.0,
)
state = {
    "task": "Fix bearer token authentication timing attack in Node.js HTTP middleware without breaking existing valid tokens.",
    "candidates": {
        "c_timing": {
            "title": "Enforce constant-time HMAC bearer comparison",
            "summary": "Hash both expected and provided tokens with SHA-256 and compare via crypto.timingSafeEqual instead of startsWith or ===."
        },
        "c_css": {
            "title": "CSS design token animation curves",
            "summary": "Configure CSS cubic-bezier transitions for dark mode secret reveal badges."
        }
    }
}
questions = {
    "q_noul_relevant": {
        "type": "noul",
        "instructions": {
            "candidate_id": "c_timing",
            "question": "Does candidate c_timing directly help fix the authentication timing attack?"
        },
        "criteria": {
            "true": "Directly fixes timing side-channel in token validation.",
            "false": "Unrelated styling or UI behavior."
        }
    },
    "q_noul_distractor": {
        "type": "noul",
        "instructions": {
            "candidate_id": "c_css",
            "question": "Does candidate c_css directly help fix the authentication timing attack?"
        },
        "criteria": {
            "true": "Directly fixes timing side-channel in token validation.",
            "false": "Unrelated styling or UI behavior."
        }
    },
    "q_choice": {
        "type": "choice",
        "instructions": "Select the highest-utility candidate for fixing the authentication timing bug.",
        "criteria": {
            "c_timing": "Constant-time timingSafeEqual comparison on SHA-256 token digests.",
            "c_css": "CSS animation curves for UI badges.",
            "NONE": "Neither candidate applies."
        }
    }
}
res = client.decide(state, questions)
print(json.dumps({
    "model": res.model,
    "input_tokens": res.input_tokens,
    "output_tokens": res.output_tokens,
    "settled_microdollars": res.settled_microdollars,
    "latency_ms": res.latency_ms,
    "answers": res.answers
}))
`;
  let stdout;
  try {
    stdout = execFileSync('python3', ['-c', script], {
      cwd: join(FOREWISP_REPO, 'scripts'),
      env: buildMinimalChildEnv({
        PYTHONPATH: join(FOREWISP_REPO, 'scripts'),
        TYPESAFE_API_KEY: typesafeKey,
        FOREWISP_BUDGET_DB: BUDGET_DB,
        FOREWISP_BUDGET_MICRODOLLARS: String(CEILING_MICRODOLLARS),
      }),
      encoding: 'utf8',
      timeout: 30_000,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(raw, [...knownSecrets, typesafeKey]), { cause: err });
  }
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.model, EXPECTED_JEV_MODEL, `Expected JEV model ${EXPECTED_JEV_MODEL}, got ${parsed.model}`);
  assert.ok(parsed.input_tokens > 0);
  const relScore = parsed.answers.q_noul_relevant?.noul;
  const distScore = parsed.answers.q_noul_distractor?.noul;
  assert.ok(typeof relScore === 'number' && relScore >= 0.7, `Expected relevant score >= 0.7, got ${relScore}`);
  assert.ok(typeof distScore === 'number' && distScore <= 0.4, `Expected distractor score <= 0.4, got ${distScore}`);
  const choice = parsed.answers.q_choice;
  assert.equal(choice?.choice, 'c_timing');
  const probSum = Object.values(choice.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(probSum - 1.0) <= 1e-6, `Choice probability sum drift: ${probSum}`);
  return parsed;
}

async function waitForHealth(url, child, getSpawnErr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sErr = getSpawnErr?.();
    if (sErr) throw sErr;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Forewisp exited early (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return await resp.json();
    } catch {
      /* daemon booting */
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for forewisp health at ${url}`);
}

async function apiJson(url, token, path, { method = 'GET', body } = {}) {
  const resp = await fetch(`${url}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: resp.status, json };
}

async function readNextOfferEvent(url, token, sessionId, cursor, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SSE timeout')), timeoutMs);
  let reader = null;
  try {
    const resp = await fetch(`${url}/v1/sessions/${encodeURIComponent(sessionId)}/offers`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        ...(cursor ? { 'Last-Event-ID': String(cursor) } : {}),
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    assert.equal(resp.status, 200, `SSE HTTP ${resp.status}`);
    assert.ok(resp.body, 'SSE response missing body');
    reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r', '');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = frame.split('\n');
        const eventType = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
        const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim();
        if (eventType !== 'offer') continue;
        const dataStr = lines
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        return { id, offer: JSON.parse(dataStr) };
      }
    }
    throw new Error('SSE stream closed before offer event');
  } finally {
    clearTimeout(timer);
    if (reader) {
      await reader.cancel().catch(() => {});
    }
    controller.abort();
  }
}

async function runRustDaemonTests(typesafeKey) {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
  let portOccupied = false;
  try {
    await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(600) });
    portOccupied = true;
  } catch {
    /* expected connection refused */
  }
  if (portOccupied) {
    throw new Error(`Port ${PORT} is already in use before verify-jev daemon startup`);
  }

  const apiToken = randomBytes(24).toString('hex');
  const logs = [];
  let spawnErr = null;
  const child = spawn(FOREWISP_BIN, [], {
    env: buildMinimalChildEnv({
      TYPESAFE_API_KEY: typesafeKey,
      FOREWISP_DECISION_PROVIDER: 'jev',
      FOREWISP_BUDGET_DB: BUDGET_DB,
      FOREWISP_BUDGET_MICRODOLLARS: String(CEILING_MICRODOLLARS),
      FOREWISP_API_TOKEN: apiToken,
      FOREWISP_BIND: `127.0.0.1:${PORT}`,
      FOREWISP_DB: TEST_DB,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (e) => {
    spawnErr = e;
  });
  child.stdout.on('data', (d) => {
    if (logs.length < 200) logs.push(String(d).trim().slice(0, 500));
  });
  child.stderr.on('data', (d) => {
    if (logs.length < 200) logs.push(String(d).trim().slice(0, 500));
  });

  try {
    const health = await waitForHealth(BASE_URL, child, () => spawnErr);
    assert.equal(health.status, 'ok');
    assert.equal(health.strategy, 'jev');

    // Seed target + 2 distractors
    const targetContrib = await apiJson(BASE_URL, apiToken, '/v1/contributions', {
      method: 'POST',
      body: {
        kind: 'memory',
        title: 'Enforce constant-time HMAC bearer token comparison',
        content:
          'When validating API bearer token secrets in Node.js middleware, digest both candidate and expected secrets with SHA-256 and compare via crypto.timingSafeEqual. Never use string startsWith or === because prefix matching leaks timing side-channels.',
        scope: 'organization',
        applicability: 'Authentication middleware in TypeScript/Node backends',
        source: 'ns-dsh://verify-jev/auth',
        reconcile: true,
      },
    });
    assert.equal(targetContrib.status, 200);
    const targetId = targetContrib.json.entry.id;

    const distractor1 = await apiJson(BASE_URL, apiToken, '/v1/contributions', {
      method: 'POST',
      body: {
        kind: 'memory',
        title: 'CSS design token animation curves',
        content:
          'Use CSS custom property --token-secret-reveal transition: 150ms cubic-bezier for bearer settings popover styling in React.',
        scope: 'organization',
        applicability: 'Frontend CSS components',
        source: 'ns-dsh://verify-jev/css',
      },
    });
    assert.equal(distractor1.status, 200);

    const distractor2 = await apiJson(BASE_URL, apiToken, '/v1/contributions', {
      method: 'POST',
      body: {
        kind: 'memory',
        title: 'Paginate bearer token audit table UI',
        content:
          'Reset page=1 in the admin UI table whenever the bearer token search filter chip changes.',
        scope: 'organization',
        applicability: 'Admin UI state management',
        source: 'ns-dsh://verify-jev/ui',
      },
    });
    assert.equal(distractor2.status, 200);

    // Test B: Synchronous /v1/recall via JEV
    const recallRes = await apiJson(BASE_URL, apiToken, '/v1/recall', {
      method: 'POST',
      body: {
        content: 'validate bearer token secret without timing side-channel',
        kinds: ['memory'],
      },
    });
    assert.equal(recallRes.status, 200);
    assert.equal(recallRes.json.strategy, 'jev');
    const recallIds = recallRes.json.entries.map((e) => e.id);
    assert.ok(recallIds.includes(targetId), `Expected JEV recall to select ${targetId}, got ${JSON.stringify(recallIds)}`);
    assert.ok(
      !recallIds.includes(distractor1.json.entry.id) && !recallIds.includes(distractor2.json.entry.id),
      `Expected JEV recall to reject CSS/UI distractors, got ${JSON.stringify(recallIds)}`,
    );

    // Test C: Proactive /v1/events + SSE /v1/sessions/{id}/offers + /v1/feedback
    const sessionId = `jev-live-${Date.now()}`;
    const ev1 = await apiJson(BASE_URL, apiToken, '/v1/events', {
      method: 'POST',
      body: {
        session_id: sessionId,
        sequence: 1,
        content: 'validate bearer token secret without timing side-channel',
        kinds: ['memory'],
      },
    });
    assert.equal(ev1.status, 202);
    assert.equal(ev1.json.accepted, true);
    assert.equal(ev1.json.sequence, 1);

    // Stream offer 1
    let offer1 = null;
    let cursor = undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const evt = await readNextOfferEvent(BASE_URL, apiToken, sessionId, cursor, 10_000);
        cursor = evt.id;
        if (evt.offer.sequence === 1) {
          offer1 = evt;
          break;
        }
      } catch (sseErr) {
        if (attempt === 2) throw sseErr;
      }
    }
    assert.ok(offer1, 'Expected SSE offer for sequence 1');
    assert.equal(offer1.offer.strategy, 'jev');
    assert.ok(
      offer1.offer.entries.some((e) => e.id === targetId),
      `Expected SSE offer 1 to include target entry ${targetId}, got ${JSON.stringify(offer1.offer.entries)}`,
    );

    // Send presented + useful feedback
    const fbPresented = await apiJson(BASE_URL, apiToken, '/v1/feedback', {
      method: 'POST',
      body: {
        session_id: sessionId,
        offer_id: Number(offer1.offer.id),
        entry_id: targetId,
        verdict: 'presented',
      },
    });
    assert.equal(fbPresented.status, 200);
    assert.equal(fbPresented.json.recorded, true);

    const fbUseful = await apiJson(BASE_URL, apiToken, '/v1/feedback', {
      method: 'POST',
      body: {
        session_id: sessionId,
        offer_id: Number(offer1.offer.id),
        entry_id: targetId,
        verdict: 'useful',
      },
    });
    assert.equal(fbUseful.status, 200);
    assert.equal(fbUseful.json.recorded, true);

    // Sequence 2 with same query should suppress already-presented target entry
    const ev2 = await apiJson(BASE_URL, apiToken, '/v1/events', {
      method: 'POST',
      body: {
        session_id: sessionId,
        sequence: 2,
        content: 'validate bearer token secret without timing side-channel',
        kinds: ['memory'],
      },
    });
    assert.equal(ev2.status, 202);
    assert.equal(ev2.json.accepted, true);

    const evt2 = await readNextOfferEvent(BASE_URL, apiToken, sessionId, cursor, 10_000);
    assert.equal(evt2.offer.sequence, 2);
    assert.equal(evt2.offer.strategy, 'jev');
    assert.ok(
      !evt2.offer.entries.some((e) => e.id === targetId),
      `Expected target ${targetId} to be suppressed after 'presented' feedback`,
    );

    return {
      health: { status: health.status, strategy: health.strategy, pilot: health.pilot },
      reconciliation: targetContrib.json.reconciliation ?? null,
      recall: {
        strategy: recallRes.json.strategy,
        selectedIds: recallIds,
        rejectedDistractors: true,
      },
      sseAndFeedback: {
        offerId: offer1.offer.id,
        strategy: offer1.offer.strategy,
        sequence1Entries: offer1.offer.entries.map((e) => e.id),
        presentedRecorded: fbPresented.json.recorded,
        usefulRecorded: fbUseful.json.recorded,
        sequence2Entries: evt2.offer.entries.map((e) => e.id),
        suppressedAfterPresented: !evt2.offer.entries.some((e) => e.id === targetId),
      },
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const secrets = [typesafeKey, apiToken];
    throw new Error(`${redactSecrets(rawMsg, secrets)}\n--- daemon logs ---\n${redactSecrets(logs.join('\n'), secrets)}`, { cause: err });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit').catch(() => {}), delay(1000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'exit').catch(() => {}), delay(500)]);
      }
    }
  }
}

async function main() {
  assert.ok(existsSync(FOREWISP_BIN), `Missing forewisp release binary at ${FOREWISP_BIN}`);
  const typesafeKey = parseTypesafeKey();
  const budgetBefore = ensureBudgetLedger();

  const directPythonProbe = runDirectPythonJevProbe(typesafeKey);
  const daemonTests = await runRustDaemonTests(typesafeKey);
  const budgetAfter = readBudgetStatus();
  const deltaMicrodollars = budgetAfter.charged_microdollars - budgetBefore.charged_microdollars;
  assert.ok(
    deltaMicrodollars <= MAX_RUN_SPEND_MICRODOLLARS,
    `Run spend ${deltaMicrodollars} microdollars exceeded per-run guard ${MAX_RUN_SPEND_MICRODOLLARS}`,
  );

  const receipt = {
    verifiedAt: new Date().toISOString(),
    endpoint: EXPECTED_JEV_ENDPOINT,
    model: EXPECTED_JEV_MODEL,
    passed: true,
    directPythonProbe,
    daemonTests,
    budgetBefore,
    budgetAfter,
    deltaMicrodollars,
  };
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(EVIDENCE_PATH, 0o600);
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((err) => {
  const raw = err instanceof Error ? err.stack || err.message : String(err);
  console.error(redactSecrets(raw, [...knownSecrets]));
  process.exitCode = 1;
});
