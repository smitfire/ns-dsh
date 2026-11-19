#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GEMINI_OPENAI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEEPSEEK_OPENAI_URL = 'https://api.deepseek.com/v1';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const MAX_DOTENV_BYTES = 1024 * 1024;
const BRIDGE_PLUGIN_PATH = join(ROOT_DIR, 'scripts', 'ocr-dsh-bridge.mjs');

const SAFE_OCR_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'NODE_ENV',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

function resolveOcrDotenvPath() {
  const allowedCandidates = [
    join(ROOT_DIR, '.env'),
    resolve(ROOT_DIR, '..', 'forewisp', '.env'),
  ];
  if (process.env.FOREWISP_DOTENV?.trim()) {
    const requested = resolve(process.env.FOREWISP_DOTENV.trim());
    const canonicalRequested = existsSync(requested) ? realpathSync(requested) : requested;
    const canonicalAllowed = allowedCandidates
      .filter((p) => existsSync(p))
      .map((p) => realpathSync(p));
    if (!canonicalAllowed.includes(canonicalRequested)) {
      throw new Error(`Refusing FOREWISP_DOTENV outside trusted repository .env paths: ${requested}`);
    }
    return requested;
  }
  for (const candidate of allowedCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readRegularFileSafe(filePath, maxBytes, label) {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof process.getuid !== 'function') {
    throw new Error(`Secure POSIX file checks (O_NOFOLLOW / getuid) are required to read ${label}`);
  }
  const uid = process.getuid();
  const st = lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== uid) {
    throw new Error(`Refusing unsafe ${label} permissions or type (require chmod 600): ${filePath}`);
  }
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fstat = fstatSync(fd);
    if (!fstat.isFile() || (fstat.mode & 0o077) !== 0 || fstat.uid !== uid) {
      throw new Error(`Refusing unsafe ${label} permissions or type (require chmod 600): ${filePath}`);
    }
    if (fstat.size > maxBytes) {
      throw new Error(`Refusing oversized ${label} file (> ${maxBytes} bytes): ${filePath}`);
    }
    const buf = Buffer.alloc(fstat.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, offset);
      if (n <= 0) {
        throw new Error(`Short read while reading ${label} file: ${filePath}`);
      }
      offset += n;
    }
    const postStat = fstatSync(fd);
    if (postStat.size !== fstat.size || (postStat.mode & 0o077) !== 0 || postStat.uid !== uid) {
      throw new Error(`Unsafe concurrent ${label} modification detected: ${filePath}`);
    }
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseDotenvFileSafe(envPath) {
  const raw = readRegularFileSafe(envPath, MAX_DOTENV_BYTES, '.env');
  const vars = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid dotenv variable name "${key}" in ${envPath}`);
    }
    const rawVal = line.slice(eq + 1).trim();
    let val;
    if (rawVal.startsWith('"') || rawVal.startsWith("'")) {
      const q = rawVal[0];
      if (rawVal.length < 2 || !rawVal.endsWith(q)) {
        throw new Error(`Unsupported or unclosed quoted value for ${key} in ${envPath}`);
      }
      const inner = rawVal.slice(1, -1);
      val = q === '"' ? inner.replace(/\\(["\\nr])/g, (_, ch) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r' }[ch])) : inner;
    } else {
      val = rawVal.replace(/\s+#.*$/, '').trim();
    }
    if (val) vars[key] = val;
  }
  return vars;
}

function resolveOcrCredentials() {
  if (process.env.OCR_LLM_TOKEN?.trim()) {
    return {
      token: process.env.OCR_LLM_TOKEN.trim(),
      url: process.env.OCR_LLM_URL || GEMINI_OPENAI_URL,
      model: process.env.OCR_LLM_MODEL || DEFAULT_GEMINI_MODEL,
      isLoopbackBridge: false,
    };
  }
  const dotenvPath = resolveOcrDotenvPath();
  const dotenvVars = dotenvPath ? parseDotenvFileSafe(dotenvPath) : {};

  const geminiKey = process.env.GEMINI_API_KEY?.trim() || dotenvVars.GEMINI_API_KEY;
  if (geminiKey) {
    return {
      token: geminiKey,
      url: process.env.OCR_LLM_URL || GEMINI_OPENAI_URL,
      model: process.env.OCR_LLM_MODEL || DEFAULT_GEMINI_MODEL,
      isLoopbackBridge: false,
    };
  }
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim() || dotenvVars.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    return {
      token: deepseekKey,
      url: process.env.OCR_LLM_URL || DEEPSEEK_OPENAI_URL,
      model: process.env.OCR_LLM_MODEL || DEFAULT_DEEPSEEK_MODEL,
      isLoopbackBridge: false,
    };
  }
  throw new Error('Missing OCR LLM credentials: set OCR_LLM_TOKEN, GEMINI_API_KEY, or DEEPSEEK_API_KEY');
}

function baseSafeEnv() {
  const env = {};
  for (const k of SAFE_OCR_ENV_KEYS) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function resolveStockDshBin() {
  const candidates = [
    join(ROOT_DIR, 'node_modules', '.bin', 'dsh'),
    join(dirname(process.execPath), 'dsh'),
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

async function startDshOcrBridge() {
  const explicitOverride = Boolean(process.env.OCR_LLM_TOKEN?.trim() && process.env.OCR_LLM_URL?.trim());
  if (explicitOverride || process.env.OCR_USE_DSH_BRIDGE === '0') {
    return null;
  }
  const dshBin = resolveStockDshBin();
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
  const credsPath = join(dshHome, '.credentials.yaml');
  if (!dshBin || !existsSync(dshHome) || !existsSync(credsPath) || !existsSync(BRIDGE_PLUGIN_PATH)) {
    return null;
  }
  if (typeof process.getuid !== 'function') {
    throw new Error('POSIX getuid check required before loading DSH credentials');
  }
  const homeStat = lstatSync(dshHome);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory() || homeStat.uid !== process.getuid() || (homeStat.mode & 0o022) !== 0) {
    throw new Error(`Refusing unsafe DSH_HOME directory: ${dshHome}`);
  }
  // Validate ownership, non-symlink status, and strict mode (0600) before handing DSH_HOME to child DSH.
  void readRegularFileSafe(credsPath, MAX_DOTENV_BYTES, 'DSH credentials');

  const workDir = mkdtempSync(join(tmpdir(), 'ns-ocr-bridge-'));
  chmodSync(workDir, 0o700);
  const bridgeToken = randomBytes(32).toString('hex');
  const handshakeSecret = randomBytes(32).toString('hex');
  const readyFile = join(workDir, 'bridge.json');
  const patchFile = join(workDir, 'patch.json');
  writeFileSync(
    patchFile,
    JSON.stringify(
      [
        { id: 'credentials', disabled: false },
        { id: 'authorization', disabled: false },
        { id: 'session-title-llm', disabled: true },
        { id: 'llm-pi-ai', config: { providers: { 'openai-codex': {} } } },
        {
          insert: [
            {
              id: 'ns-ocr-bridge',
              name: BRIDGE_PLUGIN_PATH,
              config: { readyFile, token: bridgeToken, handshakeSecret },
            },
          ],
        },
      ],
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const dshEnv = baseSafeEnv();
  dshEnv.DSH_HOME = dshHome;
  const misePnpmDir = join(homedir(), '.local', 'share', 'mise', 'installs', 'pnpm', 'latest');
  const priorityPath = [dirname(process.execPath), existsSync(misePnpmDir) ? misePnpmDir : ''].filter(Boolean);
  const existingPath = (dshEnv.PATH || '').split(delimiter).filter(Boolean);
  dshEnv.PATH = [...new Set([...priorityPath, ...existingPath])].join(delimiter);

  const child = spawn(
    dshBin,
    ['--profile', 'web', '--patch', patchFile, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    {
      cwd: workDir,
      env: dshEnv,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });

  let intentionalClose = false;
  const isAlive = () => child.exitCode === null && child.signalCode === null;
  const cleanup = async () => {
    intentionalClose = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await delay(250);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    rmSync(workDir, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      if (existsSync(readyFile)) {
        const info = JSON.parse(readRegularFileSafe(readyFile, 65536, 'bridge ready'));
        const port = Number(info?.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port from ns-ocr-bridge: ${info?.port}`);
        }
        const challenge = randomBytes(16).toString('hex');
        const clientSig = createHmac('sha256', handshakeSecret).update(`client:${challenge}`).digest('hex');
        const expectedServerHmac = createHmac('sha256', handshakeSecret).update(`server:${challenge}`).digest();
        const hsRes = await fetch(`http://127.0.0.1:${port}/_bridge_handshake?c=${challenge}&sig=${clientSig}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!hsRes.ok) {
          throw new Error(`Bridge handshake failed with status ${hsRes.status}`);
        }
        const hsBody = await hsRes.json();
        const hmacBuf = typeof hsBody?.hmac === 'string' && /^[0-9a-f]{64}$/i.test(hsBody.hmac)
          ? Buffer.from(hsBody.hmac, 'hex')
          : null;
        if (!hmacBuf || !timingSafeEqual(hmacBuf, expectedServerHmac)) {
          throw new Error('Bridge handshake HMAC mismatch; refusing to send bearer token');
        }
        if (!isAlive()) {
          throw new Error('DSH OCR bridge exited immediately after handshake');
        }
        return {
          creds: {
            token: bridgeToken,
            url: `http://127.0.0.1:${port}/v1`,
            model: process.env.OCR_LLM_MODEL || 'antigravity-gemini-4-hydrogen',
            isLoopbackBridge: true,
          },
          isAlive,
          onUnexpectedExit: (cb) => {
            if (!isAlive()) {
              if (!intentionalClose) cb();
              return;
            }
            child.once('exit', () => {
              if (!intentionalClose) cb();
            });
          },
          close: cleanup,
        };
      }
      if (!isAlive()) {
        throw new Error(`DSH OCR bridge exited early (${child.exitCode ?? child.signalCode}): ${stderrTail}`);
      }
      await delay(150);
    }
    throw new Error(`Timed out waiting for DSH OCR bridge: ${stderrTail}`);
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function buildCleanOcrEnv(creds) {
  const env = baseSafeEnv();
  let parsedUrl;
  try {
    parsedUrl = new URL(creds.url);
  } catch {
    throw new Error(`Invalid OCR_LLM_URL: ${creds.url}`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('OCR_LLM_URL must not contain embedded credentials');
  }
  const validLoopback =
    creds.isLoopbackBridge === true &&
    parsedUrl.protocol === 'http:' &&
    parsedUrl.hostname === '127.0.0.1' &&
    Number(parsedUrl.port) > 0 &&
    parsedUrl.pathname === '/v1' &&
    !parsedUrl.search &&
    !parsedUrl.hash;
  if (parsedUrl.protocol !== 'https:' && !validLoopback) {
    throw new Error('OCR_LLM_URL must be an https:// URL (or ephemeral 127.0.0.1 bridge)');
  }
  if (validLoopback) {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    env.NO_PROXY = '127.0.0.1,localhost';
  }
  env.OCR_LLM_URL = creds.url;
  env.OCR_LLM_TOKEN = creds.token;
  env.OCR_LLM_MODEL = creds.model;
  env.OCR_LLM_PROTOCOL = process.env.OCR_LLM_PROTOCOL || 'openai';
  return env;
}

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high']);
const SAFE_GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:~\d+)?$/;
const repoDir = resolve(process.argv[2] || ROOT_DIR);
const baseRef = process.argv[3] || 'main';
const effort = process.argv[4] || 'low';
const exclude = (process.env.OCR_EXCLUDE || '').trim() || 'dist/**,pnpm-lock.yaml,.local/**';

if (
  !existsSync(repoDir) ||
  !statSync(repoDir).isDirectory() ||
  !SAFE_GIT_REF_RE.test(baseRef) ||
  baseRef.includes('..') ||
  !ALLOWED_EFFORTS.has(effort) ||
  exclude.startsWith('-')
) {
  console.log(
    JSON.stringify(
      {
        repo: repoDir,
        baseRef,
        passed: false,
        blockingCount: null,
        errorKind: 'invalid_args',
        error: `Invalid args: repo=${repoDir}, baseRef=${baseRef}, effort=${effort}`,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

let bridge = null;
let creds = null;
let exitCode = 0;

try {
  let bridgeErr = null;
  try {
    bridge = await startDshOcrBridge();
  } catch (err) {
    bridgeErr = err;
    bridge = null;
  }
  if (bridge) {
    creds = bridge.creds;
  } else {
    try {
      creds = resolveOcrCredentials();
    } catch (fallbackErr) {
      if (bridgeErr) {
        const bMsg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);
        const fMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(`DSH bridge failed (${bMsg}); fallback failed (${fMsg})`);
      }
      throw fallbackErr;
    }
  }
  const ocrAbort = new AbortController();
  bridge?.onUnexpectedExit(() => {
    ocrAbort.abort(new Error('DSH OCR bridge exited unexpectedly during review'));
  });
  const { stdout } = await execFileAsync(
    'ocr',
    [
      'review',
      '--repo',
      repoDir,
      '--from',
      baseRef,
      '--exclude',
      exclude,
      '--effort',
      effort,
      '--format',
      'json',
      '--audience',
      'agent',
    ],
    {
      env: buildCleanOcrEnv(creds),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 240_000,
      signal: ocrAbort.signal,
    },
  );
  if (bridge && !bridge.isAlive()) {
    throw new Error('DSH OCR bridge exited before OCR completed');
  }

  const parsed = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Unexpected JSON root shape from ocr review');
  }
  const comments = Array.isArray(parsed.comments) ? parsed.comments.filter((c) => c && typeof c === 'object') : [];
  const blocking = comments.filter((c) => ['critical', 'high'].includes(String(c.severity || '').trim().toLowerCase()));
  const summary = {
    repo: repoDir,
    baseRef,
    model: parsed.llm?.model ?? creds.model,
    passed: blocking.length === 0,
    blockingCount: blocking.length,
    totalFindings: comments.length,
    findings: comments.map((c) => ({
      severity: c.severity,
      category: c.category,
      path: c.path,
      startLine: c.start_line,
      content: c.content,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (blocking.length > 0) exitCode = 2;
} catch (err) {
  const secrets = [creds?.token, process.env.OCR_LLM_TOKEN, process.env.GEMINI_API_KEY, process.env.DEEPSEEK_API_KEY].filter(
    Boolean,
  );
  const errObj = err && typeof err === 'object' ? err : {};
  // Avoid emitting raw child stdout/stderr (which may contain code/diff prompts); surface concise error metadata only.
  const metaParts = [errObj.message || String(err)];
  if (errObj.code !== undefined) metaParts.push(`code=${String(errObj.code)}`);
  if (errObj.signal) metaParts.push(`signal=${String(errObj.signal)}`);
  let safeMsg = metaParts.join(' | ');
  for (const s of secrets) {
    safeMsg = safeMsg.replaceAll(s, '[REDACTED]');
  }
  console.log(
    JSON.stringify(
      {
        repo: repoDir,
        baseRef,
        passed: false,
        blockingCount: null,
        errorKind: 'ocr_exec_or_config',
        error: safeMsg.slice(0, 400),
      },
      null,
      2,
    ),
  );
  exitCode = 1;
} finally {
  if (bridge) await bridge.close();
}

process.exit(exitCode);
