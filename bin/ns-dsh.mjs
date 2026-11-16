#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSwitchyardRoutesToml } from '../plugins/team/dist/core/index.js';
import { backupProfileConfig, rollbackProfileConfig, runUpgradeCanary } from '../dist/upgrade/canary.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_BIN = process.env.DSH_BIN || join(homedir(), '.local', 'bin', 'dsh');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

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
  const dshVer = spawnSync(DSH_BIN, ['--version'], { encoding: 'utf8' });
  const plugins = ['context', 'codemode', 'cuga', 'board', 'team'].map((p) => {
    const subPkg = JSON.parse(readFileSync(join(ROOT_DIR, 'plugins', p, 'package.json'), 'utf8'));
    return { name: subPkg.name, version: subPkg.version, engines: subPkg.engines };
  });
  console.log(JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    dshBinary: DSH_BIN,
    dshVersion: dshVer.error ? `unavailable (${dshVer.error.message})` : dshVer.status === 0 ? dshVer.stdout.trim() : `exit=${dshVer.status}`,
    plugins,
  }, null, 2));
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
  for (const profile of profiles) {
    const dir = resolveProfileDir(profile);
    if (existsSync(dir)) backupProfileConfig(dir);
    const res = spawnSync(DSH_BIN, ['plugin', '--profile', profile, 'add', ...pkgPaths], {
      stdio: 'inherit',
    });
    if (res.error || res.status !== 0) {
      console.error(`Failed installing into DSH profile "${profile}" (${res.error ? res.error.message : `exit=${res.status}`}). Restoring backup if present.`);
      if (existsSync(dir)) rollbackProfileConfig(dir);
      process.exit(res.status ?? 1);
    }
  }
}

function cmdUpgrade(args) {
  const dryRun = args.includes('--dry-run');
  const rawTarget = flagValue(args, '--target');
  const targetDshVersion = rawTarget && rawTarget !== 'latest' ? rawTarget : undefined;
  const canary = runUpgradeCanary({ workspaceRoot: ROOT_DIR, targetDshVersion, dryRun, runUnitTests: !dryRun });
  console.log(JSON.stringify(canary, null, 2));
  if (!canary.ok) {
    console.error('Canary verification FAILED; aborting upgrade before modifying ~/.dsh.');
    process.exit(1);
  }
  if (!dryRun) {
    const profile = flagValue(args, '--profile') || 'web';
    const dir = resolveProfileDir(profile);
    if (existsSync(dir)) backupProfileConfig(dir);
    const res = spawnSync(DSH_BIN, ['plugin', '--profile', profile, 'update'], { stdio: 'inherit' });
    if (res.error || res.status !== 0) {
      console.error(`Upgrade update failed (${res.error ? res.error.message : `exit=${res.status}`}); restoring backup.`);
      if (existsSync(dir)) rollbackProfileConfig(dir);
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
if (cmd === 'status') cmdStatus();
else if (cmd === 'install') cmdInstall(rest);
else if (cmd === 'upgrade') cmdUpgrade(rest);
else if (cmd === 'rollback') cmdRollback(rest);
else if (cmd === 'init') cmdInit(rest);
else if (cmd === 'compare') {
  const res = spawnSync(process.execPath, [join(ROOT_DIR, 'bench/cleanroom-compare.mjs'), ...rest], { stdio: 'inherit' });
  process.exit(res.status ?? 0);
} else {
  printUsage();
  process.exit(cmd ? 2 : 0);
}
