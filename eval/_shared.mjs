import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function childPath() {
  const pnpmDir = join(homedir(), '.local', 'share', 'mise', 'installs', 'pnpm', 'latest');
  const existing = (process.env.PATH || '').split(delimiter).filter(Boolean);
  return [...new Set([dirname(process.execPath), pnpmDir, ...existing])].join(delimiter);
}

export function readForewispEnvVar(rootDir, name) {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  const envPath = process.env.NS_FOREWISP_ENV_FILE || resolve(rootDir, '..', 'forewisp', '.env');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const st = lstatSync(envPath);
  if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
    throw new Error(`Unsafe forewisp .env permissions or file type: ${envPath}`);
  }
  const fd = openSync(envPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let raw = '';
  try {
    const fstat = fstatSync(fd);
    if (!fstat.isFile() || (fstat.mode & 0o077) !== 0 || (uid !== null && fstat.uid !== uid)) {
      throw new Error(`Unsafe forewisp .env permissions or file type: ${envPath}`);
    }
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cleaned = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = cleaned.indexOf('=');
    if (eq <= 0 || cleaned.slice(0, eq).trim() !== name) continue;
    let val = cleaned.slice(eq + 1).trim();
    const quoted = val.length >= 2 && val[0] === val.at(-1) && (val[0] === '"' || val[0] === "'");
    if (quoted) {
      val = val.slice(1, -1);
    } else {
      val = val.split(/\s+#/, 1)[0].trim();
    }
    if (val) return val;
  }
  throw new Error(`${name} missing in ${envPath}`);
}

export function readJevBudgetLedger(forewispBin, dbPath) {
  if (!existsSync(forewispBin)) {
    throw new Error(`Forewisp binary not found: ${forewispBin}`);
  }
  if (!existsSync(dbPath)) {
    throw new Error(`JEV budget ledger database not found: ${dbPath}`);
  }
  const sanitizedEnv = { ...process.env };
  delete sanitizedEnv.TYPESAFE_API_KEY;
  let stdout = '';
  try {
    stdout = execFileSync(forewispBin, ['budget-status', dbPath], {
      encoding: 'utf8',
      env: sanitizedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
  } catch (err) {
    throw new Error(`Failed executing forewisp budget-status: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Invalid JSON from forewisp budget-status: ${stdout.slice(0, 200)}`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.blocked !== 'boolean') {
    throw new Error(`Malformed budget-status payload: ${stdout.slice(0, 200)}`);
  }
  return parsed;
}

export async function stopChildProcessGroup(child, isGroup = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const sendSig = (sig) => {
    if (isGroup && child.pid) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* ignore */
      }
    }
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  };
  sendSig('SIGTERM');
  const deadline = Date.now() + 2500;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(80);
  }
  if (child.exitCode === null && child.signalCode === null) {
    sendSig('SIGKILL');
    await delay(250);
  }
}

export function createGitFixtureRepo(prefix, email, name, files) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['-C', dir, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', email], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', name], { stdio: 'ignore' });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'], { stdio: 'ignore' });
  return dir;
}

export async function spawnIsolatedForewispJev({
  rootDir,
  forewispBin,
  port,
  workPrefix,
  dbName,
  budgetDbPath,
  budgetMicrodollars = 25_000_000,
}) {
  const budgetParent = dirname(budgetDbPath);
  mkdirSync(budgetParent, { recursive: true });
  const realBudgetParent = realpathSync(budgetParent);
  const realBudgetDb = join(realBudgetParent, basename(budgetDbPath));
  if (!existsSync(realBudgetDb)) {
    const initEnv = { ...process.env };
    delete initEnv.TYPESAFE_API_KEY;
    execFileSync(forewispBin, ['budget-init', realBudgetDb, String(budgetMicrodollars)], {
      env: initEnv,
      stdio: 'inherit',
      timeout: 15_000,
    });
  }

  const workDir = mkdtempSync(join(tmpdir(), workPrefix));
  const realWorkDir = realpathSync(workDir);
  const apiToken = randomBytes(24).toString('hex');
  const typesafeKey = readForewispEnvVar(rootDir, 'TYPESAFE_API_KEY');
  const foreUrl = `http://127.0.0.1:${port}`;
  let stderrTail = '';

  const child = spawn(forewispBin, [], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: childPath(),
      HOME: homedir(),
      TMPDIR: tmpdir(),
      TYPESAFE_API_KEY: typesafeKey,
      FOREWISP_DECISION_PROVIDER: 'jev',
      FOREWISP_BUDGET_DB: realBudgetDb,
      FOREWISP_BUDGET_MICRODOLLARS: String(budgetMicrodollars),
      FOREWISP_API_TOKEN: apiToken,
      FOREWISP_BIND: `127.0.0.1:${port}`,
      FOREWISP_DB: join(realWorkDir, dbName),
    },
  });
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });

  const safeStderr = () => stderrTail.replaceAll(typesafeKey, '[REDACTED]').replaceAll(apiToken, '[REDACTED]');

  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Forewisp exited early (${child.exitCode ?? child.signalCode}): ${safeStderr()}`);
      }
      try {
        const h = await fetch(`${foreUrl}/health`, { signal: AbortSignal.timeout(800) });
        if (h.ok) {
          const j = await h.json();
          if (j?.status === 'ok' && j?.strategy === 'jev') {
            const unauth = await fetch(`${foreUrl}/v1/taxonomy/nodes`, { signal: AbortSignal.timeout(800) });
            const auth = await fetch(`${foreUrl}/v1/taxonomy/nodes`, {
              headers: { authorization: `Bearer ${apiToken}` },
              signal: AbortSignal.timeout(800),
            });
            const authJson = auth.ok ? await auth.json() : null;
            if ((unauth.status === 401 || unauth.status === 403) && auth.ok && Array.isArray(authJson?.nodes)) {
              return {
                apiToken,
                foreUrl,
                realBudgetDb,
                close: async () => {
                  await stopChildProcessGroup(child);
                  try {
                    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
                  } catch {
                    /* best-effort temp dir cleanup */
                  }
                },
              };
            }
            if (auth.status === 401 || auth.status === 403) {
              throw new Error(`Port ${port} responded to /health but rejected isolated apiToken (${auth.status})`);
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('rejected isolated apiToken')) {
          throw err;
        }
      }
      await delay(120);
    }
    throw new Error(`Forewisp JEV failed to become healthy on ${foreUrl}: ${safeStderr()}`);
  } catch (err) {
    await stopChildProcessGroup(child);
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    } catch {
      /* best-effort temp dir cleanup */
    }
    throw err;
  }
}
