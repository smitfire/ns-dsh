#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { childPath } from '../eval/_shared.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT_DIR, 'bin', 'ns-dsh.mjs');
const CHROME_BIN = process.env.NS_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = Number(process.env.NS_CDP_PORT || 19232);
const HOST_PORT = Number(process.env.NS_BROWSER_PORT || 17432);
const FW_PORT = Number(process.env.NS_BROWSER_FW_PORT || 18798);
const OUT_JSON = join(ROOT_DIR, '.local', 'e2e', 'gate6-board-browser.json');

function assertValidPort(port, label) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${port}`);
  }
  if (port === 7420 || port === 19222) {
    throw new Error(`Refusing reserved agent-workbench port (${port}) for ${label}`);
  }
}

async function captureWebUiEntryUrl(tmuxSocket, port) {
  const escaped = String(port).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const urlRe = new RegExp(`http://127\\.0\\.0\\.1:${escaped}/[^\\s"'<>]*`);
  const ansiRe = /\x1b\[[0-9;]*[A-Za-z]/g;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pane = execFileSync('tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-S', '-500', '-t', 'ns-dsh'], {
        encoding: 'utf8',
        timeout: 2000,
      }).replace(ansiRe, '');
      const lines = pane.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const lineMatch = lines[i].match(urlRe);
        if (lineMatch) return lineMatch[0];
        if (lines[i].includes(`http://127.0.0.1:${port}`) && i + 1 < lines.length) {
          const joined = `${lines[i].trimEnd()}${lines[i + 1].trimStart()}`;
          const wrappedMatch = joined.match(urlRe);
          if (wrappedMatch) return wrappedMatch[0];
        }
      }
    } catch {
      /* waiting for tmux output */
    }
    await delay(200);
  }
  return null;
}

async function connectCdp(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  const failAll = (msg) => {
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
  };
  ws.addEventListener('close', () => failAll('CDP WebSocket closed'));
  ws.addEventListener('error', () => failAll('CDP WebSocket error'));
  await new Promise((resolveOpen, rejectOpen) => {
    const t = setTimeout(() => rejectOpen(new Error('CDP open timeout')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(t); resolveOpen(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); rejectOpen(new Error('CDP error')); }, { once: true });
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id) {
      if (onEvent) onEvent(msg);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolveCall, rejectCall) => {
      if (ws.readyState !== WebSocket.OPEN) return rejectCall(new Error('CDP closed'));
      const id = ++nextId;
      const t = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolveCall(v); },
        reject: (e) => { clearTimeout(t); rejectCall(e); },
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { call, close: () => { failAll('CDP closing'); ws.close(); } };
}

async function launchChrome(userDataDir) {
  assert.ok(existsSync(CHROME_BIN), `Chrome binary missing: ${CHROME_BIN}`);
  let spawnError = null;
  const chrome = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  chrome.on('error', (err) => {
    spawnError = err;
  });
  try {
    let versionJson = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw spawnError;
      }
      if (chrome.exitCode !== null || chrome.signalCode !== null) {
        throw new Error(`Chrome exited prematurely (${chrome.exitCode ?? chrome.signalCode})`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
        if (res.ok) {
          versionJson = await res.json();
          break;
        }
      } catch {
        /* waiting */
      }
      await delay(150);
    }
    assert.ok(versionJson?.webSocketDebuggerUrl, 'Chrome CDP endpoint did not come up');
    return { chrome, wsUrl: versionJson.webSocketDebuggerUrl };
  } catch (err) {
    if (chrome.pid) {
      try {
        process.kill(-chrome.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

function getFlagValue(argsList, flag) {
  const idx = argsList.indexOf(flag);
  if (idx < 0) return null;
  const val = argsList[idx + 1];
  if (!val || val.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return val;
}

const args = process.argv.slice(2);
const observeMode = args.includes('--observe');
const portFlag = getFlagValue(args, '--port');
const entryUrlFlag = getFlagValue(args, '--entry-url');
const stateDirFlag = getFlagValue(args, '--state-dir');
const tmuxSocketFlag = getFlagValue(args, '--tmux-socket');
const targetPort = portFlag ? Number(portFlag) : HOST_PORT;
assertValidPort(CDP_PORT, 'CDP');
assertValidPort(targetPort, 'target');
assertValidPort(FW_PORT, 'forewisp');

const chromeUserDir = mkdtempSync(join(tmpdir(), 'ns-chrome-cdp-'));
const ownStateDir = observeMode ? null : mkdtempSync(join(tmpdir(), 'ns-browser-state-'));
let chromeProc = null;
let browser = null;
let targetId = null;

try {
  let entryUrl = entryUrlFlag || `http://127.0.0.1:${targetPort}/`;
  if (ownStateDir) {
    const started = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_BIN, 'start', '--port', String(targetPort), '--forewisp-port', String(FW_PORT), '--state-dir', ownStateDir],
        { encoding: 'utf8', env: { ...process.env, PATH: childPath(), NS_BOARD_DB_PATH: join(ownStateDir, 'board.db') }, timeout: 45_000 },
      ),
    );
    assert.equal(started.ok, true);
    const capturedUrl = await captureWebUiEntryUrl(started.tmuxSocket, targetPort);
    assert.ok(capturedUrl, `Failed capturing WebUI startup URL for port ${targetPort} from tmux pane`);
    entryUrl = capturedUrl;
  } else if (!entryUrlFlag && (tmuxSocketFlag || stateDirFlag)) {
    const tmuxSock = tmuxSocketFlag || JSON.parse(readFileSync(join(stateDirFlag, 'host.json'), 'utf8')).tmuxSocket;
    assert.ok(tmuxSock, 'Missing tmuxSocket for --observe URL capture');
    const capturedUrl = await captureWebUiEntryUrl(tmuxSock, targetPort);
    assert.ok(capturedUrl, `Failed capturing WebUI startup URL for port ${targetPort} from tmux pane`);
    entryUrl = capturedUrl;
  }

  let consoleErrors = 0;
  let pageErrors = 0;
  const launched = await launchChrome(chromeUserDir);
  chromeProc = launched.chrome;
  browser = await connectCdp(launched.wsUrl, (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors += 1;
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors += 1;
    }
  });
  const { call } = browser;

  const createdTarget = await call('Target.createTarget', { url: 'about:blank' });
  targetId = createdTarget.targetId;
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const invoke = (method, params = {}) => call(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await invoke('Runtime.evaluate', {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  await invoke('Page.enable');
  await invoke('Runtime.enable');
  await invoke('Page.navigate', { url: entryUrl });
  await delay(1500);

  const pageOk = await evaluate('document.readyState === "complete" || document.readyState === "interactive"');
  assert.equal(pageOk, true);
  const stateResp = await evaluate('fetch("/ns-board/api/state").then(async (r) => { if (!r.ok) throw new Error("/ns-board/api/state HTTP " + r.status); return r.json(); })');
  assert.equal(typeof stateResp.revision, 'number');

  if (observeMode) {
    assert.equal(consoleErrors, 0);
    assert.equal(pageErrors, 0);
    const out = {
      passed: consoleErrors === 0 && pageErrors === 0,
      observe: true,
      port: targetPort,
      cdpPort: CDP_PORT,
      boardRevision: stateResp.revision,
      cardCount: stateResp.cards?.length ?? 0,
      consoleErrors,
      pageErrors,
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    // 1. Create parent card c-cdp-1 & dependent card c-cdp-2 (enters backlog blockedBy c-cdp-1)
    const c1Res = await evaluate(`(await fetch('/ns-board/api/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c-cdp-1', title: 'CDP Root Task', owner: 'coder', modelTier: 'capable', writeScopes: ['src'] })
    })).status`);
    assert.equal(c1Res, 201);

    const c2Res = await evaluate(`(await fetch('/ns-board/api/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c-cdp-2', title: 'CDP Child Task', blockedBy: ['c-cdp-1'], owner: 'coder', modelTier: 'efficient', writeScopes: ['test'] })
    })).status`);
    assert.equal(c2Res, 201);

    // Verify unmet-dependency move to in_progress fails (400)
    const unmetStatus = await evaluate(`(await fetch('/ns-board/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardId: 'c-cdp-2', toColumn: 'in_progress' })
    })).status`);
    assert.equal(unmetStatus, 400);

    // 2. Verify EventSource live SSE delivery in browser while moving c-cdp-1 -> in_progress -> done (auto-unblocking c-cdp-2!)
    const sseResult = await evaluate(`await new Promise((resPromise, rejPromise) => {
      const es = new EventSource('/ns-board/api/events');
      let seenDone = false;
      const timer = setTimeout(() => { es.close(); rejPromise('SSE timeout'); }, 8000);
      es.onerror = () => {
        if (seenDone) return;
        clearTimeout(timer);
        es.close();
        rejPromise('SSE connection error (readyState=' + es.readyState + ')');
      };
      es.addEventListener('board', (ev) => {
        try {
          const snap = JSON.parse(ev.data);
          const child = (snap.cards || []).find(c => c.id === 'c-cdp-2');
          if (child && child.column === 'ready') {
            seenDone = true;
            clearTimeout(timer);
            es.close();
            resPromise({ revision: snap.revision, childColumn: child.column, seenDone });
          }
        } catch (err) {
          clearTimeout(timer);
          es.close();
          rejPromise(err instanceof Error ? err.message : String(err));
        }
      });
      setTimeout(async () => {
        try {
          const r1 = await fetch('/ns-board/api/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: 'c-cdp-1', toColumn: 'in_progress' }) });
          if (!r1.ok) throw new Error('move1 ' + r1.status);
          const r2 = await fetch('/ns-board/api/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: 'c-cdp-1', toColumn: 'done' }) });
          if (!r2.ok) throw new Error('move2 ' + r2.status);
        } catch (err) {
          clearTimeout(timer);
          es.close();
          rejPromise(err instanceof Error ? err.message : String(err));
        }
      }, 150);
    })`);
    assert.equal(sseResult.seenDone, true);
    assert.equal(sseResult.childColumn, 'ready');

    // 3. Stale CAS revision -> 409
    const staleCasStatus = await evaluate(`(await fetch('/ns-board/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardId: 'c-cdp-2', toColumn: 'in_progress', expectedRevision: 0 })
    })).status`);
    assert.equal(staleCasStatus, 409);

    // 4. Navigate to authenticated home UI, dismiss Preview Notice if present, open @smitfire/board sidebar panel, and verify live DOM cards
    await invoke('Page.navigate', { url: `http://127.0.0.1:${targetPort}/` });
    let sidebarPanelFound = false;
    for (let i = 0; i < 10; i += 1) {
      await delay(500);
      await evaluate('(() => { const btns = Array.from(document.querySelectorAll("button")); const cont = btns.find((b) => (b.textContent || "").trim() === "Continue"); if (cont) cont.click(); return Boolean(cont); })()');
      sidebarPanelFound = await evaluate('Boolean(document.querySelector("button[aria-label=\\"Kanban Board\\"]"))');
      if (sidebarPanelFound) break;
    }
    assert.equal(sidebarPanelFound, true, 'Missing sidebar Kanban Board button (button[aria-label="Kanban Board"])');

    const clickedPanel = await evaluate('(() => { const b = document.querySelector("button[aria-label=\\"Kanban Board\\"]"); if (!b) return false; b.click(); return true; })()');
    assert.equal(clickedPanel, true, 'Failed clicking Kanban Board sidebar button');

    let boardDom = null;
    for (let i = 0; i < 10; i += 1) {
      await delay(500);
      boardDom = await evaluate(`(() => {
        const page = document.querySelector("[data-ns-board-page]");
        const text = page ? (page.textContent || "") : "";
        return {
          text,
          doneRoot: Boolean(document.querySelector('[data-board-col="done"] [data-card-id="c-cdp-1"]')),
          readyChild: Boolean(document.querySelector('[data-board-col="ready"] [data-card-id="c-cdp-2"]')),
        };
      })()`);
      if (
        boardDom?.text?.includes('ns-dsh HITL Kanban & DAG Board') &&
        boardDom.doneRoot &&
        boardDom.readyChild
      ) {
        break;
      }
    }
    const boardPageText = boardDom?.text || '';
    const boardPageVerified = Boolean(
      boardPageText.includes('ns-dsh HITL Kanban & DAG Board') &&
      boardPageText.includes('CDP Root Task') &&
      boardPageText.includes('CDP Child Task') &&
      boardDom?.doneRoot &&
      boardDom?.readyChild,
    );
    assert.equal(boardPageVerified, true, `Board page DOM verification failed: ${JSON.stringify(boardDom)}`);

    // 5. Cross-site Origin: https://evil.example -> 403, and unauthenticated /ns-tui/api/attach -> 403
    const crossOriginRes = await fetch(`http://127.0.0.1:${targetPort}/ns-board/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'Should fail' }),
    });
    assert.equal(crossOriginRes.status, 403);

    const tuiUnauthRes = await fetch(`http://127.0.0.1:${targetPort}/ns-tui/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attached: true }),
    });
    assert.equal(tuiUnauthRes.status, 403);

    assert.equal(consoleErrors, 0);
    assert.equal(pageErrors, 0);
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    const report = {
      gate: 'gate6-board-browser',
      passed: consoleErrors === 0 && pageErrors === 0 && boardPageVerified,
      cdpPort: CDP_PORT,
      hostPort: targetPort,
      sidebarPanelVerified: sidebarPanelFound,
      boardPageVerified,
      consoleErrors,
      pageErrors,
      sseAutoUnblockRevision: sseResult.revision,
      unmetDependencyStatus: unmetStatus,
      staleCasStatus,
      crossOriginStatus: crossOriginRes.status,
      tuiUnauthAttachStatus: tuiUnauthRes.status,
    };
    writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  if (browser) {
    try {
      if (targetId) await browser.call('Target.closeTarget', { targetId });
    } catch { /* ignore */ }
    browser.close();
  }
  if (chromeProc?.pid) {
    try { process.kill(-chromeProc.pid, 'SIGTERM'); } catch { /* ignore */ }
    const waitDeadline = Date.now() + 2500;
    while (chromeProc.exitCode === null && chromeProc.signalCode === null && Date.now() < waitDeadline) {
      await delay(100);
    }
    if (chromeProc.exitCode === null && chromeProc.signalCode === null) {
      try { process.kill(-chromeProc.pid, 'SIGKILL'); } catch { /* ignore */ }
      await delay(250);
    }
  }
  if (ownStateDir) {
    try {
      execFileSync(process.execPath, [CLI_BIN, 'shutdown', '--state-dir', ownStateDir], {
        env: { ...process.env, PATH: childPath() },
        stdio: 'ignore',
        timeout: 15_000,
      });
    } catch { /* ignore */ }
    try {
      rmSync(ownStateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best-effort temp dir cleanup */ }
  }
  try {
    rmSync(chromeUserDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch { /* best-effort temp dir cleanup */ }
}
