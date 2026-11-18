#!/usr/bin/env node
/**
 * Scoped GitHub helper for all `smitfire/*` repositories without mutating global `gh auth` state.
 * Normal PR/issue/git operations are permitted on any `smitfire/*` repo; destructive force pushes
 * are additionally restricted to `smitfire/ns-dsh-e2e-sandbox` (`main` branch only).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX_SLUG = 'ns-dsh-e2e-sandbox';

const ALLOWED_GIT_SUBCOMMANDS = new Set(['push', 'pull', 'fetch', 'ls-remote']);
const ALLOWED_GIT_FLAGS_BY_SUBCMD = {
  push: new Set(['-u', '--set-upstream', '-f', '--force', '-v', '--verbose', '-q', '--quiet', '--dry-run', '--porcelain', '--no-tags', '--progress']),
  pull: new Set(['--ff-only', '-v', '--verbose', '-q', '--quiet', '--no-tags', '--progress']),
  fetch: new Set(['-v', '--verbose', '-q', '--quiet', '--no-tags', '--progress']),
  'ls-remote': new Set(['--heads', '-q', '--quiet']),
};
const ALLOWED_GH_ACTIONS = {
  pr: new Set(['view', 'list', 'create', 'comment', 'diff', 'merge']),
  issue: new Set(['view', 'list', 'create', 'comment', 'close']),
  repo: new Set(['view', 'create', 'list']),
};
const SMITFIRE_HTTPS_RE = /^https:\/\/github\.com(?::443)?\/smitfire\/([A-Za-z0-9._-]+)$/i;

function redactUrlUserinfo(rawUrl) {
  return String(rawUrl)
    .replace(/(https?:\/\/|ssh:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b[^/@\s:]+@([A-Za-z0-9.-]+:)/g, '[REDACTED]@$1');
}

function extractSmitfireSlug(rawUrl) {
  const normalized = String(rawUrl).replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = SMITFIRE_HTTPS_RE.exec(normalized);
  if (!m) return null;
  const slug = m[1];
  if (!slug || slug === '.' || slug.includes('..') || slug.includes('/')) return null;
  return slug;
}
const UNSAFE_ENV_RE =
  /^(?:GIT_.*|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GH_HOST|GH_CONFIG_DIR|GH_STATE_DIR|GH_DATA_DIR|XDG_CONFIG_HOME|XDG_STATE_HOME|XDG_DATA_HOME|SSH_ASKPASS|NS_SMITFIRE_TOKEN|LD_.*|DYLD_.*|NODE_OPTIONS|.*_PROXY)$/i;

function sanitizedEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!UNSAFE_ENV_RE.test(k)) out[k] = v;
  }
  return { ...out, ...extra };
}

function requireSmitfireHttpsSlug(rawUrl, contextLabel) {
  if (/^(?:ssh:\/\/|git@)/i.test(rawUrl)) {
    throw new Error(
      `Unsupported SSH remote URL (${contextLabel}); gh-smitfire requires https://github.com/smitfire/* for GIT_ASKPASS`,
    );
  }
  const slug = extractSmitfireSlug(rawUrl);
  if (!slug) {
    throw new Error(`Refusing non-smitfire HTTPS URL (${contextLabel}): ${redactUrlUserinfo(rawUrl)}`);
  }
  return slug;
}

function buildAndValidateGitArgv(rawArgs) {
  let hasC = false;
  let repoDir = process.cwd();
  let idx = 0;
  if (rawArgs[0] === '-C' && rawArgs[1] && !rawArgs[1].startsWith('-')) {
    hasC = true;
    repoDir = rawArgs[1];
    idx = 2;
  }
  if (!existsSync(repoDir)) {
    throw new Error(`Repository directory does not exist: ${repoDir}`);
  }
  const userTail = rawArgs.slice(idx);
  if (userTail.some((a) => /^-c/i.test(a))) {
    throw new Error('Refusing user-supplied -c config flags');
  }
  const subcmd = rawArgs[idx];
  if (!subcmd || !ALLOWED_GIT_SUBCOMMANDS.has(subcmd)) {
    throw new Error(`Unsupported git subcommand for smitfire helper: ${subcmd ?? '(none)'}`);
  }
  const allowedSubcmdFlags = ALLOWED_GIT_FLAGS_BY_SUBCMD[subcmd];
  const restArgs = rawArgs.slice(idx + 1);
  const validatedFlags = [];
  const positional = [];
  for (const arg of restArgs) {
    if (arg.startsWith('-')) {
      // Git accepts flags after positional arguments in some forms; require all flags first so positionals cannot smuggle options.
      if (positional.length > 0) {
        throw new Error(`Refusing git option after positional argument: ${arg}`);
      }
      if (arg === '--') {
        throw new Error('Refusing `--` separator before explicit positional validation');
      }
      if (arg.startsWith('--force-with-lease')) {
        const leaseMatch = arg.match(/^--force-with-lease=([A-Za-z0-9._/-]+)(?::[0-9a-f]{7,64})?$/i);
        if (subcmd !== 'push' || !leaseMatch || leaseMatch[1].includes('..')) {
          throw new Error(`Refusing unsupported or un-scoped --force-with-lease form: ${arg}`);
        }
        validatedFlags.push(arg);
        continue;
      }
      if (!allowedSubcmdFlags.has(arg)) {
        throw new Error(`Refusing disallowed git flag for ${subcmd}: ${arg}`);
      }
      validatedFlags.push(arg);
      continue;
    }
    if (arg.startsWith('+')) {
      throw new Error('Refusing unconstrained forced refspec');
    }
    if (/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(arg)) {
      requireSmitfireHttpsSlug(arg, 'remote argument');
    }
    positional.push(arg);
  }
  for (const ref of positional.slice(1)) {
    if (
      ref.includes(':') ||
      ref.includes('..') ||
      ref.startsWith('/') ||
      ref.startsWith('refs/tags/') ||
      !/^(?:refs\/heads\/)?[A-Za-z0-9._/-]+$/.test(ref)
    ) {
      throw new Error(`Refusing unsafe git refspec: ${ref}`);
    }
  }
  const readGitConfigAll = (key) => {
    try {
      const raw = execFileSync('git', ['-C', repoDir, 'config', '--get-all', key], {
        encoding: 'utf8',
        env: sanitizedEnv(),
        timeout: 15_000,
      });
      return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch (err) {
      if (!err || typeof err !== 'object' || err.status !== 1) throw err;
      return [];
    }
  };
  for (const pattern of ['^url\\..*\\.insteadof', '^url\\..*\\.pushinsteadof']) {
    let insteadOf = '';
    try {
      insteadOf = execFileSync('git', ['-C', repoDir, 'config', '--get-regexp', pattern], {
        encoding: 'utf8',
        env: sanitizedEnv(),
        timeout: 15_000,
      }).trim();
    } catch (err) {
      if (!err || typeof err !== 'object' || err.status !== 1) throw err;
    }
    if (insteadOf) {
      throw new Error('Refusing git credential injection while url.*.insteadOf config overrides are present');
    }
  }
  const remoteTarget = positional[0] || 'origin';
  let repoSlug = '';
  if (/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(remoteTarget)) {
    repoSlug = requireSmitfireHttpsSlug(remoteTarget, 'explicit target');
  } else {
    if (!/^[A-Za-z0-9._-]+$/.test(remoteTarget)) {
      throw new Error(`Invalid git remote target: ${remoteTarget}`);
    }
    const disallowedRemoteKeys = [
      `remote.${remoteTarget}.push`,
      `remote.${remoteTarget}.receivepack`,
      `remote.${remoteTarget}.uploadpack`,
    ];
    for (const k of disallowedRemoteKeys) {
      if (readGitConfigAll(k).length > 0) {
        throw new Error(`Refusing git operation with overridden config key: ${k}`);
      }
    }
    const fetchUrls = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', '--all', remoteTarget], {
      encoding: 'utf8',
      env: sanitizedEnv(),
      timeout: 15_000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const pushUrls = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', '--push', '--all', remoteTarget], {
      encoding: 'utf8',
      env: sanitizedEnv(),
      timeout: 15_000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (fetchUrls.length === 0 || pushUrls.length === 0) {
      throw new Error(`Missing fetch or push URL for remote ${remoteTarget}`);
    }
    const slugs = [
      ...fetchUrls.map((u) => requireSmitfireHttpsSlug(u, `fetch URL for ${remoteTarget}`)),
      ...pushUrls.map((u) => requireSmitfireHttpsSlug(u, `push URL for ${remoteTarget}`)),
    ];
    const canonicalSlug = slugs[0].toLowerCase();
    if (slugs.some((s) => s.toLowerCase() !== canonicalSlug)) {
      throw new Error(`Refusing multiple or mismatched remote URL slugs for ${remoteTarget}`);
    }
    repoSlug = slugs[0];
  }
  // Exact allowlist in validatedFlags rejects abbreviated long flags like `--for`; every accepted force flag is enumerated here.
  const hasForce = validatedFlags.some((a) => a === '-f' || a === '--force' || a.startsWith('--force-with-lease='));
  if (hasForce) {
    if (subcmd !== 'push' || repoSlug.toLowerCase() !== SANDBOX_SLUG) {
      throw new Error(`Refusing force operation for non-sandbox target (${subcmd} ${repoSlug})`);
    }
    const pushedRefs = positional.slice(1);
    if (pushedRefs.length === 0 || !pushedRefs.every((r) => r === 'main' || r === 'refs/heads/main')) {
      throw new Error('Force push on sandbox repository is restricted to main');
    }
    for (const arg of validatedFlags) {
      if (arg.startsWith('--force-with-lease=')) {
        const leaseRef = arg.slice('--force-with-lease='.length).split(':')[0];
        if (leaseRef !== 'main' && leaseRef !== 'refs/heads/main') {
          throw new Error(`Refusing --force-with-lease for non-main ref: ${leaseRef}`);
        }
      }
    }
  }
  return [
    ...(hasC ? ['-C', repoDir] : []),
    '-c',
    'credential.helper=',
    '-c',
    'credential.useHttpPath=true',
    subcmd,
    ...validatedFlags,
    ...positional,
  ];
}

const cmd = process.argv[2];
const args = process.argv.slice(3);
if (!cmd || !['gh', 'git'].includes(cmd)) {
  console.error('Usage: gh-smitfire.mjs <gh|git> [args...]');
  process.exit(1);
}

let token = '';
try {
  token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'smitfire'], {
    encoding: 'utf8',
    env: sanitizedEnv(),
    timeout: 15_000,
  }).trim();
} catch {
  token = '';
}
if (!token) {
  console.error('Failed to resolve GitHub token for smitfire');
  process.exit(1);
}

const SMITFIRE_SLUG_RE = /^smitfire\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
// Per-action gh CLI flag allowlists so unrelated flags are rejected outside their intended command.
const GH_ACTION_POLICY = {
  'pr view': { bool: new Set(), value: new Set(['--repo', '-R', '--json']) },
  'pr list': { bool: new Set(), value: new Set(['--repo', '-R', '--state', '--limit', '--search', '--json', '--base', '--head']) },
  'pr create': { bool: new Set(), value: new Set(['--repo', '-R', '--title', '--body', '--base', '--head']) },
  'pr comment': { bool: new Set(), value: new Set(['--repo', '-R', '--body']) },
  'pr diff': { bool: new Set(), value: new Set(['--repo', '-R']) },
  'pr merge': { bool: new Set(['--squash', '--merge', '--rebase', '--delete-branch']), value: new Set(['--repo', '-R']) },
  'issue view': { bool: new Set(), value: new Set(['--repo', '-R', '--json']) },
  'issue list': { bool: new Set(), value: new Set(['--repo', '-R', '--state', '--limit', '--search', '--json']) },
  'issue create': { bool: new Set(), value: new Set(['--repo', '-R', '--title', '--body']) },
  'issue comment': { bool: new Set(), value: new Set(['--repo', '-R', '--body']) },
  'issue close': { bool: new Set(), value: new Set(['--repo', '-R', '--comment']) },
  'repo view': { bool: new Set(), value: new Set(['--json']) },
  'repo create': { bool: new Set(['--private']), value: new Set(['--description', '--visibility']) },
  'repo list': { bool: new Set(), value: new Set(['--limit', '--visibility', '--json']) },
};

function validateGhArgs(rawArgs) {
  const category = rawArgs[0];
  const action = rawArgs[1];
  const allowedActions = category ? ALLOWED_GH_ACTIONS[category] : undefined;
  const actionKey = `${category} ${action}`;
  const actionPolicy = GH_ACTION_POLICY[actionKey];
  if (!allowedActions || !action || !allowedActions.has(action) || !actionPolicy) {
    throw new Error(`Unsupported or unsafe gh operation: ${rawArgs.slice(0, 2).join(' ')}`);
  }
  const rest = rawArgs.slice(2);
  let explicitRepo = null;
  const setRepo = (val) => {
    if (explicitRepo !== null) throw new Error('Duplicate --repo/-R flag in gh invocation');
    if (!val || !SMITFIRE_SLUG_RE.test(val) || val.includes('..')) {
      throw new Error(`Invalid or non-smitfire --repo/-R target: ${val || '(empty)'}`);
    }
    explicitRepo = val;
  };
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const flagName = eq >= 0 ? a.slice(0, eq) : a;
      const isBool = actionPolicy.bool.has(flagName);
      const isVal = actionPolicy.value.has(flagName);
      if (!isBool && !isVal) {
        throw new Error(`Disallowed gh flag for ${actionKey}: ${flagName}`);
      }
      if (isBool) {
        if (eq >= 0) throw new Error(`Boolean gh flag cannot take a value: ${flagName}`);
        continue;
      }
      const val = eq >= 0 ? a.slice(eq + 1) : rest[++i];
      if (val === undefined) throw new Error(`Missing value for gh flag: ${flagName}`);
      if (eq < 0 && val.startsWith('-')) {
        throw new Error(`Value for ${flagName} cannot start with '-' when passed separately`);
      }
      if (flagName === '--visibility' && val.toLowerCase() === 'public') {
        throw new Error('Refusing public visibility in gh helper');
      }
      if (flagName === '--repo') setRepo(val);
      if ((flagName === '--head' || flagName === '--base') && val.includes(':')) {
        throw new Error(`Refusing cross-repo ${flagName} ref: ${val}`);
      }
      continue;
    }
    if (a.startsWith('-')) {
      if (!actionPolicy.value.has('-R')) {
        throw new Error(`Disallowed short gh flag for ${actionKey}: ${a}`);
      }
      if (a === '-R') {
        const val = rest[++i];
        if (val === undefined || val.startsWith('-')) throw new Error('Missing or invalid value for -R');
        setRepo(val);
        continue;
      }
      if (a.startsWith('-R=')) {
        setRepo(a.slice('-R='.length));
        continue;
      }
      if (a.startsWith('-R') && a.length > 2) {
        setRepo(a.slice(2));
        continue;
      }
      throw new Error(`Disallowed short gh flag: ${a}`);
    }
    positionals.push(a);
  }

  if (explicitRepo !== null && (!SMITFIRE_SLUG_RE.test(explicitRepo) || explicitRepo.includes('..'))) {
    throw new Error(`Refusing non-smitfire --repo target: ${explicitRepo}`);
  }
  if (category === 'pr' || category === 'issue') {
    if (!explicitRepo || !SMITFIRE_SLUG_RE.test(explicitRepo)) {
      throw new Error(`gh ${category} ${action} requires an explicit smitfire/* --repo`);
    }
    if (action === 'create' || action === 'list') {
      if (positionals.length > 0) {
        throw new Error(`gh ${category} ${action} does not accept unexpected positional targets`);
      }
    } else if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
      throw new Error(`gh ${category} ${action} requires a single numeric ${category} ID alongside --repo`);
    }
  }
  if (category === 'repo') {
    if (action === 'list') {
      if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== 'smitfire')) {
        throw new Error(`gh repo list owner must be smitfire, got: ${positionals[0]}`);
      }
    } else if (positionals.length !== 1 || !SMITFIRE_SLUG_RE.test(positionals[0]) || positionals[0].includes('..')) {
      throw new Error(`gh repo ${action} requires a single explicit smitfire/* target`);
    }
  }
}

if (cmd === 'gh') {
  try {
    validateGhArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const ghConfigDir = mkdtempSync(join(tmpdir(), 'ns-gh-cfg-'));
  chmodSync(ghConfigDir, 0o700);
  try {
    const res = spawnSync('gh', args, {
      env: sanitizedEnv({
        GH_TOKEN: token,
        GH_HOST: 'github.com',
        GH_CONFIG_DIR: ghConfigDir,
        GH_PROMPT_DISABLED: '1',
      }),
      stdio: 'inherit',
      timeout: 120_000,
    });
    process.exit(res.status ?? 1);
  } finally {
    rmSync(ghConfigDir, { recursive: true, force: true });
  }
}

let gitArgv;
try {
  gitArgv = buildAndValidateGitArgv(args);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

let askDir = null;
let exitCode = 1;
try {
  askDir = mkdtempSync(join(tmpdir(), 'ns-askpass-'));
  chmodSync(askDir, 0o700);
  const tokenFile = join(askDir, 'token.secret');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const askHelper = join(askDir, 'askpass.mjs');
  writeFileSync(
    askHelper,
    `import { readFileSync } from 'node:fs';
const prompt = (process.argv[2] || '').trimEnd();
const match = /^(Username|Password) for (?:'([^']+)'|(\\S+?)):?$/.exec(prompt);
const rawUrl = match ? (match[2] ?? match[3]) : '';
let parsed;
try {
  parsed = new URL(rawUrl);
} catch {
  process.stderr.write('gh-smitfire askpass rejected malformed prompt URL\\n');
  process.exit(1);
}
const parts = parsed.pathname.replace(/\\/+$/, '').replace(/\\.git$/i, '').split('/').filter(Boolean);
const valid =
  parsed.protocol === 'https:' &&
  parsed.hostname.toLowerCase() === 'github.com' &&
  (!parsed.port || parsed.port === '443') &&
  !parsed.search &&
  !parsed.hash &&
  !parsed.password &&
  (!parsed.username || parsed.username === 'smitfire') &&
  parts.length === 2 &&
  parts[0].toLowerCase() === 'smitfire' &&
  parts[1] !== '.' &&
  /^[A-Za-z0-9._-]+$/.test(parts[1]) &&
  !parts[1].includes('..');
if (!valid) {
  process.stderr.write('gh-smitfire askpass rejected non-smitfire prompt\\n');
  process.exit(1);
}
if (match[1] === 'Username') {
  process.stdout.write('smitfire\\n');
} else {
  process.stdout.write(readFileSync(${JSON.stringify(tokenFile)}, 'utf8'));
}
`,
    { mode: 0o600 },
  );
  const quotedExec = `'${process.execPath.replace(/'/g, "'\\''")}'`;
  const quotedHelper = `'${askHelper.replace(/'/g, "'\\''")}'`;
  const askScript = join(askDir, 'askpass.sh');
  writeFileSync(askScript, `#!/bin/sh\nexec ${quotedExec} ${quotedHelper} "$1"\n`, { mode: 0o700 });
  // Read the secret via a mode-0600 file in askDir with useHttpPath=true so credentials only unlock for smitfire/*.
  const res = spawnSync('git', gitArgv, {
    env: sanitizedEnv({
      GIT_ASKPASS: askScript,
      GIT_TERMINAL_PROMPT: '0',
    }),
    stdio: 'inherit',
    timeout: 120_000,
  });
  exitCode = res.status ?? 1;
} finally {
  if (askDir) rmSync(askDir, { recursive: true, force: true });
}
process.exit(exitCode);
