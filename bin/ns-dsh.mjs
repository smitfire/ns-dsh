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
  status                          Show installed DSH version and workspace plugin versions
  install [--profile <web|headless>]  Install ns-dsh + 5 child plugins into DSH profile(s)
  upgrade [--target <ver>] [--dry-run] [--profile <name>]
                                  Run canary verification before upgrading DSH profile
  rollback [--profile <name>]     Restore profile package.json & cordis.patch.yml backup
  init [--agy|--claude|--cursor|--switchyard] [--out <dir>]
                                  Export harness-agnostic MCP config or Switchyard routes.toml
  compare [args...]               Run 3-way cleanroom comparison harness (bench/cleanroom-compare.mjs)
`);
}

function resolveProfileDir(profile) {
  return join(DSH_HOME, 'profiles', profile);
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
    dshVersion: dshVer.status === 0 ? dshVer.stdout.trim() : 'unavailable',
    plugins,
  }, null, 2));
}

function cmdInstall(args) {
  const idx = args.indexOf('--profile');
  const profiles = idx >= 0 && args[idx + 1] ? [args[idx + 1]] : ['headless', 'web'];
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
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      console.error(`Failed installing into DSH profile "${profile}" (exit=${res.status})`);
      process.exit(res.status ?? 1);
    }
  }
}

function cmdUpgrade(args) {
  const dryRun = args.includes('--dry-run');
  const tIdx = args.indexOf('--target');
  const targetDshVersion = tIdx >= 0 ? args[tIdx + 1] : undefined;
  const canary = runUpgradeCanary({ workspaceRoot: ROOT_DIR, targetDshVersion, dryRun });
  console.log(JSON.stringify(canary, null, 2));
  if (!canary.ok) {
    console.error('Canary verification FAILED; aborting upgrade before modifying ~/.dsh.');
    process.exit(1);
  }
  if (!dryRun) {
    const pIdx = args.indexOf('--profile');
    const profile = pIdx >= 0 && args[pIdx + 1] ? args[pIdx + 1] : 'web';
    const dir = resolveProfileDir(profile);
    if (existsSync(dir)) backupProfileConfig(dir);
    console.log(`Backed up profile "${profile}". Target @deepseek-ai/dsh@${canary.targetDshVersion} cleared canary.`);
  }
}

function cmdRollback(args) {
  const pIdx = args.indexOf('--profile');
  const profiles = pIdx >= 0 && args[pIdx + 1] ? [args[pIdx + 1]] : ['headless', 'web'];
  for (const profile of profiles) {
    const ok = rollbackProfileConfig(resolveProfileDir(profile));
    console.log(`Rollback profile "${profile}": ${ok ? 'restored backup' : 'no backup found'}`);
  }
}

function cmdInit(args) {
  const outIdx = args.indexOf('--out');
  const outDir = resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : process.cwd());
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
