#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSwitchyardRoutesToml } from '../plugins/team/dist/core/index.js';
import { backupProfileConfig, rollbackProfileConfig, runUpgradeCanary, WORKSPACE_PLUGINS } from '../dist/upgrade/canary.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = process.env.NS_DSH_HOME || process.env.DSH_HOME || join(homedir(), '.dsh');
const misePnpmDir = join(homedir(), '.local', 'share', 'mise', 'installs', 'pnpm', 'latest');
const PNPM_BIN_DIR = process.env.PNPM_BIN_DIR || (existsSync(misePnpmDir) ? misePnpmDir : '');
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FOREWISP_BIN = process.env.FOREWISP_BIN || join(ROOT_DIR, '.local', 'forewisp-target', 'release', 'forewisp');
const FOREWISP_BUDGET_MICRODOLLARS = '25000000';
const DEFAULT_HOST_PORT = 7430;
const DEFAULT_FOREWISP_PORT = 8797;
const CHILD_PLUGINS = WORKSPACE_PLUGINS;

function isStockDshCandidate(candidatePath) {
  if (!existsSync(candidatePath)) return false;
  try {
    const resolved = realpathSync(candidatePath).replace(/\\/g, '/');
    return !resolved.includes('workbench') && resolved.includes('@deepseek-ai/dsh');
  } catch {
    return false;
  }
}

function resolveStockDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const binName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const candidates = [
    join(ROOT_DIR, 'node_modules', '.bin', binName),
    join(dirname(process.execPath), binName),
    join(homedir(), '.local', 'bin', binName),
  ];
  for (const cand of candidates) {
    if (isStockDshCandidate(cand)) return cand;
  }
  return 'dsh';
}

const DSH_BIN = resolveStockDshBin();

function childEnv(extra = {}) {
  const dshBinDir = isAbsolute(DSH_BIN) ? dirname(DSH_BIN) : '';
  const priorityDirs = [dirname(process.execPath), PNPM_BIN_DIR, dshBinDir].filter(Boolean);
  const existing = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const merged = [...new Set([...priorityDirs, ...existing])].join(delimiter);
  return { ...process.env, DSH_HOME, ...extra, PATH: merged };
}

function resolveDshVersion(dshVer) {
  if (dshVer.error) return `unavailable (${dshVer.error.message})`;
  if (dshVer.status === 0) return dshVer.stdout.trim();
  return `exit=${dshVer.status}`;
}

function printUsage() {
  console.log(`Usage: ns-dsh [command] [options]

Commands:
  tui [--resume <id> | --new]       Attach Claude/agy-style tmux TUI (default command)
  start [--port <n>] [--resume <id> | --new]
                                      Start persistent tmux DSH host + Forewisp JEV daemon + keepalive watchdog
  shutdown                            Gracefully stop persistent ns-dsh host & Forewisp daemon
  board [--port <n>]                  Show WebUI Kanban URL & snapshot summary
  tasks [--port <n>]                  Print current Kanban board tasks as JSON
  status                              Show installed DSH version and workspace plugin versions
  install [--profile <web|headless>]  Install ns-dsh + 6 child plugins into DSH profile(s)
  upgrade [--target <ver>] [--dry-run] [--profile <name>]
                                      Run canary verification before updating DSH / profile
  rollback [--profile <name>]         Restore profile package.json & cordis.patch.yml backup
  init [--agy|--claude|--cursor|--switchyard] [--out <dir>]
                                      Export harness-agnostic MCP config or Switchyard routes.toml
  compare [args...]                   Run comparison harness (bench/cleanroom-compare.mjs)
`);
}

function resolveProfileDir(profile) {
  return join(DSH_HOME, 'profiles', profile);
}

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith('-')) {
    throw new Error(`flag ${flag} requires a value`);
  }
  return next;
}

function cmdStatus() {
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
  const dshVer = spawnSync(DSH_BIN, ['--version'], { env: childEnv(), encoding: 'utf8' });
  const plugins = CHILD_PLUGINS.map((p) => {
    const subPkg = JSON.parse(readFileSync(join(ROOT_DIR, 'plugins', p, 'package.json'), 'utf8'));
    return { name: subPkg.name, version: subPkg.version, engines: subPkg.engines };
  });
  console.log(JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    dshBinary: DSH_BIN,
    dshVersion: resolveDshVersion(dshVer),
    plugins,
  }, null, 2));
}

function rollbackProfiles(profileNames) {
  for (const name of profileNames) {
    const pDir = resolveProfileDir(name);
    if (!existsSync(pDir)) {
      console.error(`Skipping rollback for profile "${name}" (directory missing).`);
      continue;
    }
    const restored = rollbackProfileConfig(pDir);
    console.error(restored ? `Restored backup for profile "${name}".` : `No backup found for profile "${name}".`);
  }
}

function cmdInstall(args) {
  const explicitProfile = flagValue(args, '--profile');
  const profiles = explicitProfile ? [explicitProfile] : ['headless', 'web'];
  const pkgPaths = [
    ...CHILD_PLUGINS.map((p) => join(ROOT_DIR, 'plugins', p)),
    ROOT_DIR,
  ];
  const installed = [];
  for (const profile of profiles) {
    const dir = resolveProfileDir(profile);
    if (existsSync(dir)) backupProfileConfig(dir);
    const res = spawnSync(DSH_BIN, ['plugin', '--profile', profile, 'add', ...pkgPaths], {
      env: childEnv(),
      stdio: 'inherit',
    });
    if (res.error || res.status !== 0) {
      console.error(`Failed installing into DSH profile "${profile}" (${res.error ? res.error.message : `exit=${res.status}`}).`);
      rollbackProfiles([...installed.reverse(), profile]);
      process.exit(res.status ?? 1);
    }
    installed.push(profile);
  }
}

function cmdUpgrade(args) {
  const dryRun = args.includes('--dry-run');
  const rawTarget = flagValue(args, '--target');
  const targetDshVersion = rawTarget && rawTarget !== 'latest' ? rawTarget : undefined;
  if (targetDshVersion && !SEMVER_RE.test(targetDshVersion)) {
    throw new Error(`Invalid --target version "${targetDshVersion}"`);
  }
  const canary = runUpgradeCanary({ workspaceRoot: ROOT_DIR, targetDshVersion, dryRun, runUnitTests: !dryRun });
  console.log(JSON.stringify(canary, null, 2));
  if (!canary.ok) {
    console.error('Canary verification FAILED; aborting upgrade before modifying ~/.dsh.');
    process.exit(1);
  }
  if (!dryRun) {
    const profile = flagValue(args, '--profile') || 'web';
    const dir = resolveProfileDir(profile);
    if (!existsSync(dir)) {
      console.error(`DSH profile "${profile}" not found at ${dir}; nothing to upgrade.`);
      process.exit(1);
    }
    backupProfileConfig(dir);

    let upgradedGlobalFrom = '';
    if (targetDshVersion) {
      const cur = spawnSync(DSH_BIN, ['--version'], { env: childEnv(), encoding: 'utf8' });
      const currentVerMatch = (cur.stdout || '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
      const currentVer = currentVerMatch ? currentVerMatch[0] : '';
      if (currentVer !== targetDshVersion) {
        const npmBin = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
        const upDsh = spawnSync(npmBin, ['install', '-g', `@deepseek-ai/dsh@${targetDshVersion}`], {
          env: childEnv(),
          stdio: 'inherit',
        });
        if (upDsh.error || upDsh.status !== 0) {
          console.error(`Failed installing @deepseek-ai/dsh@${targetDshVersion} (${upDsh.error ? upDsh.error.message : `exit=${upDsh.status}`}). Global npm prefix may need manual verification.`);
          rollbackProfiles([profile]);
          process.exit(upDsh.status ?? 1);
        }
        upgradedGlobalFrom = currentVer;
      }
    }

    const res = spawnSync(DSH_BIN, ['plugin', '--profile', profile, 'update'], { env: childEnv(), stdio: 'inherit' });
    if (res.error || res.status !== 0) {
      console.error(`Upgrade update failed (${res.error ? res.error.message : `exit=${res.status}`}).`);
      rollbackProfiles([profile]);
      if (upgradedGlobalFrom) {
        const npmBin = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
        console.error(`Attempting to restore global @deepseek-ai/dsh@${upgradedGlobalFrom}...`);
        const restoreDsh = spawnSync(npmBin, ['install', '-g', `@deepseek-ai/dsh@${upgradedGlobalFrom}`], {
          env: childEnv(),
          stdio: 'inherit',
        });
        if (restoreDsh.error || restoreDsh.status !== 0) {
          const errDetail = restoreDsh.error ? restoreDsh.error.message : `exit=${restoreDsh.status}`;
          console.error(`Could not auto-restore @deepseek-ai/dsh@${upgradedGlobalFrom} (${errDetail}); run: npm install -g @deepseek-ai/dsh@${upgradedGlobalFrom}`);
        }
      }
      process.exit(res.status ?? 1);
    }
  }
}

function cmdRollback(args) {
  const explicitProfile = flagValue(args, '--profile');
  const profiles = explicitProfile ? [explicitProfile] : ['headless', 'web'];
  for (const profile of profiles) {
    const ok = rollbackProfileConfig(resolveProfileDir(profile));
    console.log(`Rollback profile "${profile}": ${ok ? 'restored backup' : 'no backup found'}`);
  }
}

function cmdInit(args) {
  const outDir = resolve(flagValue(args, '--out') || process.cwd());
  mkdirSync(outDir, { recursive: true });
  const mcpConfig = {
    mcpServers: Object.fromEntries(
      CHILD_PLUGINS.filter((p) => existsSync(join(ROOT_DIR, 'plugins', p, 'dist', 'mcp', 'server.js'))).map((p) => [
        `ns-${p}`,
        { command: 'node', args: [join(ROOT_DIR, 'plugins', p, 'dist', 'mcp', 'server.js')] },
      ]),
    ),
  };

  const wrote = [];
  if (args.includes('--agy')) {
    const p = join(outDir, 'ns-dsh.agy.mcp.json');
    writeFileSync(p, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
    wrote.push(p);
  }
  if (args.includes('--claude')) {
    const p = join(outDir, '.mcp.json');
    writeFileSync(p, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
    wrote.push(p);
  }
  if (args.includes('--cursor')) {
    const p = join(outDir, '.cursor', 'mcp.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
    wrote.push(p);
  }
  if (args.includes('--switchyard')) {
    const p = join(outDir, 'switchyard.routes.toml');
    writeFileSync(p, `${generateSwitchyardRoutesToml()}\n`, 'utf8');
    wrote.push(p);
  }
  if (wrote.length === 0) {
    console.log(JSON.stringify({ mcpConfig, switchyardRoutesPreview: generateSwitchyardRoutesToml().split('\n').slice(0, 12) }, null, 2));
  } else {
    console.log(JSON.stringify({ generated: wrote }, null, 2));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function validateServicePort(raw, defaultPort, label) {
  const port = Number(raw ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${raw}`);
  }
  if (port === 7420 || port === 19222) {
    throw new Error(`Refusing reserved agent-workbench port ${port} for ${label}`);
  }
  return port;
}

function resolveStateDir(args) {
  const raw = flagValue(args, '--state-dir') || process.env.NS_DSH_STATE_DIR || join(homedir(), '.local', 'state', 'ns-dsh');
  mkdirSync(raw, { recursive: true, mode: 0o700 });
  const st = lstatSync(raw);
  const curUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (st.isSymbolicLink() || !st.isDirectory() || (curUid !== null && st.uid !== curUid)) {
    throw new Error(`Unsafe state directory: ${raw}`);
  }
  const canonical = realpathSync(raw);
  chmodSync(canonical, 0o700);
  return canonical;
}

function resolveTmuxSocket(stateDir) {
  let canonical = resolve(stateDir);
  try {
    canonical = realpathSync(stateDir);
  } catch {
    /* stateDir may not exist yet for read-only lookups */
  }
  return `ns-dsh-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

function readTypesafeKeySafe() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  const candidates = process.env.NS_FOREWISP_ENV_FILE
    ? [process.env.NS_FOREWISP_ENV_FILE]
    : [join(DSH_HOME, 'forewisp.env'), join(ROOT_DIR, '.env'), resolve(ROOT_DIR, '..', 'forewisp', '.env')];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const envFile of candidates) {
    let raw = '';
    try {
      if (!existsSync(envFile)) continue;
      const st = lstatSync(envFile);
      if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) continue;
      const fd = openSync(envFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const fstat = fstatSync(fd);
        if (!fstat.isFile() || (fstat.mode & 0o077) !== 0 || (uid !== null && fstat.uid !== uid)) continue;
        const buf = Buffer.alloc(fstat.size);
        const bytes = readSync(fd, buf, 0, buf.length, 0);
        raw = buf.subarray(0, bytes).toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0 || line.slice(0, eq).trim() !== 'TYPESAFE_API_KEY') continue;
      const val = line.slice(eq + 1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
      if (val) return val;
    }
  }
  return undefined;
}

function ensureTokenFile(stateDir, fileName) {
  const tokenPath = join(stateDir, fileName);
  const tok = randomBytes(24).toString('hex');
  try {
    writeFileSync(tokenPath, `${tok}\n`, { mode: 0o600, flag: 'wx' });
    return tok;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code !== 'EEXIST') {
      throw err;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const st = lstatSync(tokenPath);
    if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
      throw new Error(`Unsafe token file permissions or type at ${tokenPath}`);
    }
    const fd = openSync(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let existing = '';
    try {
      const fstat = fstatSync(fd);
      if (!fstat.isFile() || (fstat.mode & 0o077) !== 0 || (uid !== null && fstat.uid !== uid)) {
        throw new Error(`Unsafe token file permissions or type at ${tokenPath}`);
      }
      const buf = Buffer.alloc(fstat.size);
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      existing = buf.subarray(0, bytes).toString('utf8').trim();
    } finally {
      closeSync(fd);
    }
    if (!existing) {
      throw new Error(`Empty or corrupt token file at ${tokenPath}`);
    }
    return existing;
  }
}

async function httpJson(url, opts = {}) {
  const headers = {
    ...(opts.headers ?? {}),
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    redirect: 'manual',
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function probeForewispAuthenticated(url, apiToken) {
  const h = await httpJson(`${url}/health`, { timeoutMs: 800 });
  if (!h.ok || !h.json || typeof h.json !== 'object' || h.json.status !== 'ok' || typeof h.json.strategy !== 'string') {
    const transient = h.status === 429 || h.status >= 500;
    return { verified: false, transient, kind: transient ? 'transient' : 'foreign', status: h.status };
  }
  const unauthProbe = await httpJson(`${url}/v1/taxonomy/nodes`, { timeoutMs: 800 });
  if (unauthProbe.ok) {
    return { verified: false, transient: false, kind: 'foreign', status: unauthProbe.status };
  }
  if (unauthProbe.status !== 401 && unauthProbe.status !== 403) {
    const transient = unauthProbe.status === 429 || unauthProbe.status >= 500;
    return { verified: false, transient, kind: transient ? 'transient' : 'foreign', status: unauthProbe.status };
  }
  const authProbe = await httpJson(`${url}/v1/taxonomy/nodes`, {
    headers: { authorization: `Bearer ${apiToken}` },
    timeoutMs: 800,
  });
  const validShape =
    authProbe.ok &&
    authProbe.json !== null &&
    typeof authProbe.json === 'object' &&
    typeof authProbe.json.taxonomy_id === 'string' &&
    Array.isArray(authProbe.json.nodes);
  const authFailed = authProbe.status === 401 || authProbe.status === 403;
  const transient = authProbe.status === 429 || authProbe.status >= 500;
  return {
    verified: validShape,
    transient,
    kind: validShape ? 'ok' : authFailed ? 'auth_mismatch' : transient ? 'transient' : 'foreign',
    status: authProbe.status,
  };
}

function buildForewispEnv(typesafeKey, budgetDb, apiToken, forewispPort, corpusDb) {
  const out = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return Object.assign(out, {
    TYPESAFE_API_KEY: typesafeKey,
    FOREWISP_DECISION_PROVIDER: 'jev',
    FOREWISP_BUDGET_DB: budgetDb,
    FOREWISP_BUDGET_MICRODOLLARS,
    FOREWISP_API_TOKEN: apiToken,
    FOREWISP_BIND: `127.0.0.1:${forewispPort}`,
    FOREWISP_DB: corpusDb,
  });
}

async function stopOwnedPidGracefully(pid, requiredTokens, timeoutMs = 2000) {
  if (!pid || !isOwnedProcess(pid, requiredTokens)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isPidAlive(pid);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await sleep(60);
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    const killDeadline = Date.now() + 500;
    while (Date.now() < killDeadline && isPidAlive(pid)) {
      await sleep(40);
    }
  }
  return !isPidAlive(pid);
}

async function ensureForewispDaemon(stateDir, forewispPort) {
  const url = `http://127.0.0.1:${forewispPort}`;
  const apiToken = ensureTokenFile(stateDir, 'forewisp.token');
  const fwPidPath = join(stateDir, 'forewisp.pid');
  let initialProbeStatus = null;
  let initialProbeKind = null;
  let probeNetworkErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const probe = await probeForewispAuthenticated(url, apiToken);
      if (probe.verified) {
        persistAdoptedForewispPid(fwPidPath, forewispPort);
        return { running: true, url, token: apiToken, alreadyRunning: true };
      }
      initialProbeStatus = probe.status;
      initialProbeKind = probe.kind;
      probeNetworkErr = null;
      if (!probe.transient) break;
    } catch (err) {
      const code = err && typeof err === 'object' ? (err.cause?.code ?? err.code) : undefined;
      initialProbeStatus = null;
      initialProbeKind = null;
      if (code === 'ECONNREFUSED') {
        probeNetworkErr = null;
        break;
      }
      probeNetworkErr = code || (err instanceof Error ? err.message : String(err));
    }
    await sleep(250);
  }
  if (initialProbeKind === 'auth_mismatch') {
    const stalePid = findOwnedListeningPid(forewispPort, [FOREWISP_BIN]);
    if (stalePid && (await stopOwnedPidGracefully(stalePid, [FOREWISP_BIN])) && !findOwnedListeningPid(forewispPort, [FOREWISP_BIN])) {
      initialProbeStatus = null;
      initialProbeKind = null;
    }
  }
  if (initialProbeStatus !== null) {
    const label = initialProbeKind === 'auth_mismatch' ? 'forewisp token mismatch' : 'port occupied';
    return { running: false, url: undefined, token: undefined, reason: `${label} on ${forewispPort} (HTTP ${initialProbeStatus})` };
  }
  if (probeNetworkErr !== null) {
    return { running: false, url: undefined, token: undefined, reason: `port ${forewispPort} probe failed (${probeNetworkErr})` };
  }
  if (!existsSync(FOREWISP_BIN)) {
    return { running: false, url: undefined, token: undefined, reason: 'forewisp binary absent' };
  }
  const typesafeKey = readTypesafeKeySafe();
  if (!typesafeKey) {
    return { running: false, url: undefined, token: undefined, reason: 'TYPESAFE_API_KEY absent' };
  }
  const rawBudgetDb = process.env.NS_JEV_BUDGET_DB || join(ROOT_DIR, '.local', 'e2e', 'jev-budget.sqlite');
  mkdirSync(dirname(rawBudgetDb), { recursive: true });
  const budgetDb = join(realpathSync(dirname(rawBudgetDb)), basename(rawBudgetDb));
  if (!existsSync(budgetDb)) {
    const initRes = spawnSync(FOREWISP_BIN, ['budget-init', budgetDb, FOREWISP_BUDGET_MICRODOLLARS], { stdio: 'inherit' });
    if (initRes.status !== 0) throw new Error(`Failed to initialize JEV budget ledger at ${budgetDb}`);
  }
  const corpusDb = join(stateDir, 'forewisp-corpus.sqlite');
  const child = spawn(FOREWISP_BIN, [], {
    detached: true,
    stdio: 'ignore',
    env: buildForewispEnv(typesafeKey, budgetDb, apiToken, forewispPort, corpusDb),
  });
  child.unref();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      try {
        const racedProbe = await probeForewispAuthenticated(url, apiToken);
        if (racedProbe.verified) {
          persistAdoptedForewispPid(fwPidPath, forewispPort);
          return { running: true, url, token: apiToken, alreadyRunning: true };
        }
      } catch {
        /* fall through to report premature exit */
      }
      rmSync(fwPidPath, { force: true });
      throw new Error(`Forewisp daemon exited prematurely (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const probe = await probeForewispAuthenticated(url, apiToken);
      if (probe.verified && child.pid && isPidAlive(child.pid)) {
        writeFileSync(fwPidPath, `${child.pid}\n`, { mode: 0o600 });
        return { running: true, url, token: apiToken, pid: child.pid };
      }
    } catch {
      /* waiting */
    }
    await sleep(120);
  }
  const listenerPid = findOwnedListeningPid(forewispPort, [FOREWISP_BIN]);
  for (const pid of new Set([child.pid, listenerPid].filter(Boolean))) {
    await stopOwnedPidGracefully(pid, [FOREWISP_BIN]);
  }
  rmSync(fwPidPath, { force: true });
  throw new Error(`Forewisp daemon failed to become healthy on ${url}`);
}

function getPanePid(tmuxSock) {
  const res = spawnSync('tmux', ['-L', tmuxSock, 'display-message', '-p', '-t', 'ns-dsh', '#{pane_pid}'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (res.status !== 0) return undefined;
  const pid = Number(res.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ALLOWED_OWNED_BINS = new Set(['node', 'dsh', 'forewisp', 'agent-context', basename(process.execPath), basename(DSH_BIN), basename(FOREWISP_BIN)]);

function isOwnedProcess(pid, requiredTokens) {
  if (!isPidAlive(pid)) return false;
  const tokens = Array.isArray(requiredTokens) ? requiredTokens : [requiredTokens];
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'uid=,command='], { encoding: 'utf8', timeout: 1500 });
  if (ps.status !== 0 || !ps.stdout) return false;
  const trimmed = ps.stdout.trim();
  const sp = trimmed.search(/\s+/);
  if (sp < 0) return false;
  const uid = Number(trimmed.slice(0, sp));
  const cmdLine = trimmed.slice(sp).trim();
  const curUid = typeof process.getuid === 'function' ? process.getuid() : uid;
  if (!Number.isInteger(uid) || uid !== curUid || !cmdLine) return false;
  if (!ALLOWED_OWNED_BINS.has(basename(cmdLine.split(/\s+/)[0]))) return false;
  return tokens.every((t) => new RegExp(`(?:^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`).test(cmdLine));
}

function findOwnedListeningPid(port, requiredTokens) {
  if (!Number.isInteger(port) || port <= 0) return null;
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 1500 });
  if (lsof.status !== 0 || !lsof.stdout) return null;
  for (const line of lsof.stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0 && isOwnedProcess(pid, requiredTokens)) return pid;
  }
  return null;
}

function persistAdoptedForewispPid(fwPidPath, forewispPort) {
  const existing = readValidPid(fwPidPath);
  if (existing && isOwnedProcess(existing, [FOREWISP_BIN])) return;
  const adoptedPid = findOwnedListeningPid(forewispPort, [FOREWISP_BIN]);
  if (adoptedPid) writeFileSync(fwPidPath, `${adoptedPid}\n`, { mode: 0o600 });
}

function readHostMetaSafe(hostMetaPath) {
  if (!existsSync(hostMetaPath)) return null;
  try {
    return JSON.parse(readFileSync(hostMetaPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeHostMetaAtomic(hostMetaPath, meta) {
  const tmpPath = `${hostMetaPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, hostMetaPath);
}

function readValidPid(pidPath) {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readPersistedSessionId(stateDir) {
  try {
    const file = join(stateDir, 'last-session.json');
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed?.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function spawnHostWatchdog(stateDir) {
  if (process.env.NS_DSH_DISABLE_HOST_WATCHDOG === '1') return;
  const pidPath = join(stateDir, 'watchdog.pid');
  const existingPid = readValidPid(pidPath);
  if (existingPid && isOwnedProcess(existingPid, [fileURLToPath(import.meta.url), '__watchdog', stateDir])) return;
  rmSync(pidPath, { force: true });
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '__watchdog', '--state-dir', stateDir],
    {
      detached: true,
      stdio: 'ignore',
      env: childEnv({ NS_DSH_DISABLE_HOST_WATCHDOG: '1' }),
    },
  );
  child.unref();
  if (child.pid) {
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
  }
}

async function withStateLock(stateDir, fn) {
  const lockPath = join(stateDir, 'state.lock');
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      break;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code !== 'EEXIST') throw err;
      // Staleness heuristic: only reclaim state.lock when the recorded PID is invalid/dead, serialized by atomic mkdir.
      const holder = readValidPid(lockPath);
      if (!holder || !isPidAlive(holder)) {
        const reapDir = join(stateDir, 'state.lock.reap');
        try {
          if (existsSync(reapDir) && Date.now() - lstatSync(reapDir).mtimeMs > 5000) {
            rmSync(reapDir, { recursive: true, force: true });
          }
          mkdirSync(reapDir, { mode: 0o700 });
          try {
            const innerHolder = readValidPid(lockPath);
            if (!innerHolder || !isPidAlive(innerHolder)) rmSync(lockPath, { force: true });
          } finally {
            rmSync(reapDir, { recursive: true, force: true });
          }
        } catch (reapErr) {
          if (reapErr && typeof reapErr === 'object' && 'code' in reapErr && reapErr.code !== 'EEXIST') throw reapErr;
          if (Date.now() >= deadline) throw new Error(`Timed out acquiring state lock at ${lockPath}`);
          await sleep(25);
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring state lock at ${lockPath}`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    if (readValidPid(lockPath) === process.pid) {
      rmSync(lockPath, { force: true });
    }
  }
}

async function cmdWatchdog(args) {
  const stateDir = resolveStateDir(args);
  const once = args.includes('--once');
  const intervalMs = Math.max(500, Number(flagValue(args, '--interval-ms') ?? 10_000));
  const pidPath = join(stateDir, 'watchdog.pid');
  let stopping = false;
  let consecutiveFailures = 0;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  while (!stopping) {
    if (!once) {
      if (existsSync(pidPath)) {
        const ownerPid = readValidPid(pidPath);
        if (ownerPid !== process.pid) {
          if (ownerPid && isPidAlive(ownerPid) && isOwnedProcess(ownerPid, [fileURLToPath(import.meta.url), '__watchdog', stateDir])) {
            break;
          }
          writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
        }
      } else {
        writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
      }
    }
    const hostMetaPath = join(stateDir, 'host.json');
    const meta = readHostMetaSafe(hostMetaPath);
    if (!meta || meta.shutdownRequested === true) break;

    const tmuxSock = meta.tmuxSocket || resolveTmuxSocket(stateDir);
    const hasTmux = spawnSync('tmux', ['-L', tmuxSock, 'has-session', '-t', 'ns-dsh'], { stdio: 'ignore' }).status === 0;
    let fwHealthy = !meta.forewispRunning;
    if (meta.forewispRunning && meta.forewispPort) {
      try {
        const h = await httpJson(`http://127.0.0.1:${meta.forewispPort}/health`, { timeoutMs: 1200 });
        fwHealthy = h.ok && h.json && typeof h.json === 'object' && h.json.status === 'ok';
      } catch {
        fwHealthy = false;
      }
    }

    if (!hasTmux || !fwHealthy) {
      try {
        const restarted = await ensureStarted(
          [
            '--state-dir',
            stateDir,
            '--port',
            String(meta.port ?? DEFAULT_HOST_PORT),
            '--forewisp-port',
            String(meta.forewispPort ?? DEFAULT_FOREWISP_PORT),
          ],
          { quiet: true, skipWatchdog: true, fromWatchdog: true },
        );
        if (restarted === null || readHostMetaSafe(hostMetaPath)?.shutdownRequested === true) break;
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) break;
      }
    } else {
      consecutiveFailures = 0;
    }
    if (once || stopping) break;
    await sleep(intervalMs);
  }

  try {
    if (readValidPid(pidPath) === process.pid) {
      rmSync(pidPath, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/** Returns started host descriptor, or `null` when a watchdog restart is aborted by shutdown tombstone. */
async function ensureStarted(args, opts = {}) {
  const stateDir = resolveStateDir(args);
  return withStateLock(stateDir, async () => {
    const hostMetaPath = join(stateDir, 'host.json');
    const existingMeta = readHostMetaSafe(hostMetaPath);
    if (opts.fromWatchdog && (!existingMeta || existingMeta.shutdownRequested === true)) {
      return null;
    }
    const port = validateServicePort(
      flagValue(args, '--port') ?? process.env.NS_DSH_PORT ?? existingMeta?.port,
      DEFAULT_HOST_PORT,
      'ns-dsh host',
    );
    const forewispPort = validateServicePort(
      flagValue(args, '--forewisp-port') ?? process.env.NS_FOREWISP_PORT ?? existingMeta?.forewispPort,
      DEFAULT_FOREWISP_PORT,
      'forewisp daemon',
    );
    if (port === forewispPort) {
      throw new Error(`Refusing identical port ${port} for both ns-dsh host and Forewisp daemon`);
    }
    const tmuxSock = resolveTmuxSocket(stateDir);
    if (!opts.fromWatchdog) {
      writeHostMetaAtomic(hostMetaPath, {
        ...(existingMeta && typeof existingMeta === 'object' ? existingMeta : {}),
        port,
        forewispPort,
        tmuxSocket: tmuxSock,
        stateDir,
        dshHome: DSH_HOME,
        shutdownRequested: false,
      });
    }
    const isNewSession = args.includes('--new');
    const explicitResume = flagValue(args, '--resume');
    const resumeId = explicitResume || (isNewSession ? undefined : readPersistedSessionId(stateDir));
    let spawnedTmuxHere = false;
    let spawnedFwPid;
    const stopNewlyStarted = async () => {
      if (spawnedTmuxHere) spawnSync('tmux', ['-L', tmuxSock, 'kill-session', '-t', 'ns-dsh'], { stdio: 'ignore' });
      if (spawnedFwPid) {
        await stopOwnedPidGracefully(spawnedFwPid, [FOREWISP_BIN], 2000);
        rmSync(join(stateDir, 'forewisp.pid'), { force: true });
      }
    };
    const abortIfShutdownRequested = async () => {
      if (readHostMetaSafe(hostMetaPath)?.shutdownRequested !== true) return false;
      await stopNewlyStarted();
      if (opts.fromWatchdog) return true;
      throw new Error('Host startup aborted due to concurrent shutdown');
    };
    try {
      const fw = await ensureForewispDaemon(stateDir, forewispPort);
      if (fw.running && !fw.alreadyRunning && fw.pid) spawnedFwPid = fw.pid;
      if (!fw.running) {
        console.error(`[ns-dsh] warning: Forewisp JEV disabled (${fw.reason ?? 'unavailable'})`);
      }
      const tuiToken = ensureTokenFile(stateDir, 'tui.token');

      const has = spawnSync('tmux', ['-L', tmuxSock, 'has-session', '-t', 'ns-dsh'], { stdio: 'ignore' });
      if (has.status !== 0) {
        const launchEnv = childEnv({
          NS_DSH_TUI: '1',
          NS_DSH_TUI_TOKEN: tuiToken,
          NS_DSH_TMUX_SOCKET: tmuxSock,
          NS_DSH_STATE_DIR: stateDir,
          ...(isNewSession ? { NS_DSH_NEW_SESSION: '1' } : {}),
          ...(resumeId ? { NS_DSH_RESUME: resumeId } : {}),
          ...(fw.url ? { FOREWISP_URL: fw.url, NS_FOREWISP_URL: fw.url } : {}),
          ...(fw.token ? { FOREWISP_API_TOKEN: fw.token } : {}),
        });
        for (const secretKey of ['TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'OCR_LLM_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
          delete launchEnv[secretKey];
        }
        if (!fw.token) {
          delete launchEnv.FOREWISP_API_TOKEN;
          delete launchEnv.FOREWISP_URL;
          delete launchEnv.NS_FOREWISP_URL;
        }
        const spawned = spawnSync(
          'tmux',
          [
            '-L',
            tmuxSock,
            'new-session',
            '-d',
            '-s',
            'ns-dsh',
            '-x',
            '120',
            '-y',
            '40',
            process.execPath,
            DSH_BIN,
            '--profile',
            'web',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--no-open',
          ],
          { env: launchEnv, stdio: 'pipe', encoding: 'utf8' },
        );
        if (spawned.status !== 0) {
          throw new Error(`Failed starting tmux host: ${spawned.stderr || spawned.stdout || `exit=${spawned.status}`}`);
        }
        spawnedTmuxHere = true;
      }

      let tuiStatus = null;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (await abortIfShutdownRequested()) return null;
        const alive = spawnSync('tmux', ['-L', tmuxSock, 'has-session', '-t', 'ns-dsh'], { stdio: 'ignore' });
        if (alive.status !== 0) {
          throw new Error(`ns-dsh tmux session exited before HTTP API came up on port ${port}`);
        }
        try {
          const st = await httpJson(`http://127.0.0.1:${port}/ns-tui/api/status`, {
            headers: { 'x-ns-tui-token': tuiToken },
            timeoutMs: 1000,
          });
          if (st.ok) {
            tuiStatus = st.json;
            break;
          }
        } catch {
          /* waiting */
        }
        await sleep(150);
      }
      if (!tuiStatus) {
        throw new Error(`Timed out waiting for http://127.0.0.1:${port}/ns-tui/api/status`);
      }

      const panePid = getPanePid(tmuxSock);
      if (await abortIfShutdownRequested()) return null;
      const summary = {
        ok: true,
        port,
        forewispPort,
        forewispRunning: fw.running,
        ...(fw.running ? {} : { forewispReason: fw.reason ?? 'unavailable' }),
        tmuxSocket: tmuxSock,
        panePid,
        stateDir,
        dshHome: DSH_HOME,
        shutdownRequested: false,
      };
      writeHostMetaAtomic(hostMetaPath, summary);
      if (!opts.skipWatchdog) {
        spawnHostWatchdog(stateDir);
      }
      if (!opts.quiet) {
        console.log(JSON.stringify({ ...summary, tuiStatus }, null, 2));
      }
      return { ...summary, tuiToken };
    } catch (err) {
      await stopNewlyStarted();
      if (!opts.fromWatchdog) {
        const latest = readHostMetaSafe(hostMetaPath);
        try {
          if (existingMeta && typeof existingMeta === 'object') {
            writeHostMetaAtomic(hostMetaPath, {
              ...existingMeta,
              shutdownRequested: latest?.shutdownRequested === true || existingMeta.shutdownRequested === true,
            });
          } else if (latest?.shutdownRequested === true) {
            writeHostMetaAtomic(hostMetaPath, {
              port,
              forewispPort,
              tmuxSocket: tmuxSock,
              stateDir,
              dshHome: DSH_HOME,
              shutdownRequested: true,
            });
          } else {
            rmSync(hostMetaPath, { force: true });
          }
        } catch {
          /* ignore rollback write failure */
        }
      }
      throw err;
    }
  });
}

async function cmdTui(args) {
  const host = await ensureStarted(args, { quiet: true });
  if (!host) throw new Error('Host startup aborted due to concurrent shutdown');
  const tuiHeaders = { 'x-ns-tui-token': host.tuiToken };
  const resumeId = flagValue(args, '--resume');
  if (resumeId) {
    const res = await httpJson(`http://127.0.0.1:${host.port}/ns-tui/api/resume`, {
      method: 'POST',
      headers: tuiHeaders,
      body: { sessionId: resumeId },
      timeoutMs: 5000,
    });
    if (!res.ok) throw new Error(`Failed resuming session ${resumeId}: HTTP ${res.status}`);
  }
  await httpJson(`http://127.0.0.1:${host.port}/ns-tui/api/attach`, {
    method: 'POST',
    headers: tuiHeaders,
    body: { attached: true },
  }).catch(() => {});
  let attError = null;
  let exitCode = 0;
  try {
    const att = spawnSync('tmux', ['-L', host.tmuxSocket, 'attach-session', '-t', 'ns-dsh'], {
      stdio: 'inherit',
      env: childEnv({ NS_DSH_TMUX_SOCKET: host.tmuxSocket }),
    });
    if (att.error) attError = att.error;
    exitCode = att.status ?? (att.signal ? 1 : 0);
  } finally {
    await httpJson(`http://127.0.0.1:${host.port}/ns-tui/api/attach`, {
      method: 'POST',
      headers: tuiHeaders,
      body: { attached: false },
    }).catch(() => {});
  }
  if (attError) throw attError;
  process.exitCode = exitCode;
}

async function cmdShutdown(args) {
  const stateDir = resolveStateDir(args);
  const hostMetaPath = join(stateDir, 'host.json');
  const preTombstoneRaw = existsSync(hostMetaPath) ? readFileSync(hostMetaPath, 'utf8') : null;
  const writeTombstone = () => {
    const existing = readHostMetaSafe(hostMetaPath);
    const tombstone = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      shutdownRequested: true,
      stoppedAt: new Date().toISOString(),
    };
    try {
      writeHostMetaAtomic(hostMetaPath, tombstone);
    } catch {
      /* ignore write error */
    }
  };
  // Signal tombstone immediately before waiting on state.lock so in-flight watchdog starts abort promptly.
  writeTombstone();
  let acquiredLock = false;
  try {
    return await withStateLock(stateDir, async () => {
      acquiredLock = true;
      const existing = readHostMetaSafe(hostMetaPath);
      writeTombstone();
      const wdPidPath = join(stateDir, 'watchdog.pid');
      const wdPid = readValidPid(wdPidPath);
      if (wdPid && isOwnedProcess(wdPid, [fileURLToPath(import.meta.url), '__watchdog', stateDir])) {
        await stopOwnedPidGracefully(wdPid, [fileURLToPath(import.meta.url), '__watchdog', stateDir], 1000);
      }
      rmSync(wdPidPath, { force: true });
      const tmuxSock =
        typeof existing?.tmuxSocket === 'string' && /^ns-dsh-[0-9a-f]{12}$/.test(existing.tmuxSocket)
          ? existing.tmuxSocket
          : resolveTmuxSocket(stateDir);
      const panePid = getPanePid(tmuxSock);
      if (panePid && isOwnedProcess(panePid, [DSH_BIN, '--profile', 'web'])) {
        await stopOwnedPidGracefully(panePid, [DSH_BIN, '--profile', 'web'], 2000);
      }
      spawnSync('tmux', ['-L', tmuxSock, 'kill-session', '-t', 'ns-dsh'], { stdio: 'ignore' });
      const fwPidPath = join(stateDir, 'forewisp.pid');
      const recordedFwPid = readValidPid(fwPidPath);
      const fwPid =
        recordedFwPid ??
        (Number.isInteger(existing?.forewispPort) ? findOwnedListeningPid(existing.forewispPort, [FOREWISP_BIN]) : null);
      if (fwPid) {
        await stopOwnedPidGracefully(fwPid, [FOREWISP_BIN], 2000);
      }
      if (Number.isInteger(existing?.forewispPort)) {
        const remainingFw = findOwnedListeningPid(existing.forewispPort, [FOREWISP_BIN]);
        if (remainingFw) {
          throw new Error(`Forewisp daemon pid ${remainingFw} failed to exit during shutdown`);
        }
      }
      rmSync(fwPidPath, { force: true });
      console.log(JSON.stringify({ ok: true, stopped: true, tmuxSocket: tmuxSock }));
    });
  } catch (err) {
    if (!acquiredLock) {
      try {
        if (preTombstoneRaw !== null) {
          const restoreTmp = `${hostMetaPath}.restore.${process.pid}`;
          writeFileSync(restoreTmp, preTombstoneRaw, { mode: 0o600 });
          renameSync(restoreTmp, hostMetaPath);
        } else {
          rmSync(hostMetaPath, { force: true });
        }
      } catch {
        /* ignore rollback failure */
      }
    }
    throw err;
  }
}

async function cmdBoard(args, tasksOnly = false) {
  const stateDir = resolveStateDir(args);
  const hostMetaPath = join(stateDir, 'host.json');
  const existingMeta = readHostMetaSafe(hostMetaPath);
  const port = validateServicePort(flagValue(args, '--port') ?? process.env.NS_DSH_PORT ?? existingMeta?.port, DEFAULT_HOST_PORT, 'ns-dsh host');
  const res = await httpJson(`http://127.0.0.1:${port}/ns-board/api/state`);
  if (!res.ok) throw new Error(`Failed querying board on port ${port}: HTTP ${res.status}`);
  const boardPayload = res.json ?? {};
  console.log(JSON.stringify(tasksOnly ? boardPayload : { url: `http://127.0.0.1:${port}/`, board: boardPayload }, null, 2));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      printUsage();
      return;
    }
    await cmdTui(rest);
  } else if (cmd === '--resume' || cmd === '--new') {
    await cmdTui([cmd, ...rest]);
  } else if (cmd === 'tui') {
    await cmdTui(rest);
  } else if (cmd === 'start') {
    await ensureStarted(rest);
  } else if (cmd === '__watchdog') {
    await cmdWatchdog(rest);
  } else if (cmd === 'shutdown') {
    await cmdShutdown(rest);
  } else if (cmd === 'board') {
    await cmdBoard(rest, false);
  } else if (cmd === 'tasks') {
    await cmdBoard(rest, true);
  } else if (cmd === 'status') {
    cmdStatus();
  } else if (cmd === 'install') {
    cmdInstall(rest);
  } else if (cmd === 'upgrade') {
    cmdUpgrade(rest);
  } else if (cmd === 'rollback') {
    cmdRollback(rest);
  } else if (cmd === 'init') {
    cmdInit(rest);
  } else if (cmd === 'compare') {
    const res = spawnSync(process.execPath, [join(ROOT_DIR, 'bench/cleanroom-compare.mjs'), ...rest], {
      env: childEnv(),
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  } else if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printUsage();
  } else {
    printUsage();
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
