#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSwitchyardRoutesToml } from '../plugins/team/dist/core/index.js';
import { backupProfileConfig, rollbackProfileConfig, runUpgradeCanary } from '../dist/upgrade/canary.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const misePnpmDir = join(homedir(), '.local', 'share', 'mise', 'installs', 'pnpm', 'latest');
const PNPM_BIN_DIR = process.env.PNPM_BIN_DIR || (existsSync(misePnpmDir) ? misePnpmDir : '');
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
  console.log(`Usage: ns-dsh <command> [options]

Commands:
  status                              Show installed DSH version and workspace plugin versions
  install [--profile <web|headless>]  Install ns-dsh + 5 child plugins into DSH profile(s)
  upgrade [--target <ver>] [--dry-run] [--profile <name>]
                                      Run canary verification before updating DSH / profile
  rollback [--profile <name>]         Restore profile package.json & cordis.patch.yml backup
  init [--agy|--claude|--cursor|--switchyard] [--out <dir>]
                                      Export harness-agnostic MCP config or Switchyard routes.toml
  compare [args...]                   Run 3-way cleanroom comparison harness (bench/cleanroom-compare.mjs)
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
  const plugins = ['context', 'codemode', 'cuga', 'board', 'team'].map((p) => {
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
    join(ROOT_DIR, 'plugins', 'context'),
    join(ROOT_DIR, 'plugins', 'codemode'),
    join(ROOT_DIR, 'plugins', 'cuga'),
    join(ROOT_DIR, 'plugins', 'board'),
    join(ROOT_DIR, 'plugins', 'team'),
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
    mcpServers: {
      'ns-context': { command: 'node', args: [join(ROOT_DIR, 'plugins/context/dist/mcp/server.js')] },
      'ns-codemode': { command: 'node', args: [join(ROOT_DIR, 'plugins/codemode/dist/mcp/server.js')] },
      'ns-cuga': { command: 'node', args: [join(ROOT_DIR, 'plugins/cuga/dist/mcp/server.js')] },
      'ns-board': { command: 'node', args: [join(ROOT_DIR, 'plugins/board/dist/mcp/server.js')] },
      'ns-team': { command: 'node', args: [join(ROOT_DIR, 'plugins/team/dist/mcp/server.js')] },
    },
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

const [, , cmd, ...rest] = process.argv;
try {
  if (cmd === 'status') cmdStatus();
  else if (cmd === 'install') cmdInstall(rest);
  else if (cmd === 'upgrade') cmdUpgrade(rest);
  else if (cmd === 'rollback') cmdRollback(rest);
  else if (cmd === 'init') cmdInit(rest);
  else if (cmd === 'compare') {
    const res = spawnSync(process.execPath, [join(ROOT_DIR, 'bench/cleanroom-compare.mjs'), ...rest], {
      env: childEnv(),
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  } else {
    printUsage();
    process.exit(cmd ? 2 : 0);
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  printUsage();
  process.exit(2);
}
