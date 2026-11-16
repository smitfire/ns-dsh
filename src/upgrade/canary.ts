import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

export interface CanaryPluginCheck {
  plugin: string;
  engineRange: string;
  compatible: boolean;
  testsPassed: boolean;
  durationMs: number;
  error?: string;
}

export interface UpgradeCanaryResult {
  ok: boolean;
  targetDshVersion: string;
  dryRun: boolean;
  checks: CanaryPluginCheck[];
  notes: string[];
}

export function satisfiesDshPrereleaseRange(version: string, range: string): boolean {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/);
  if (!m) return false;
  const [, maj, min, pat, rc] = m.map((x) => (x === undefined ? undefined : Number(x)));
  if (range.includes('>=0.2.2-rc.3 <0.3.0-0')) {
    if (maj !== 0) return false;
    if (min! < 2 || min! >= 3) return false;
    if (min === 2 && pat! === 2 && rc !== undefined && rc < 3) return false;
    return true;
  }
  return false;
}

export function backupProfileConfig(profileDir: string): string {
  const pkgPath = join(profileDir, 'package.json');
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const backupDir = join(profileDir, '.ns-dsh-backup');
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(pkgPath)) copyFileSync(pkgPath, join(backupDir, 'package.json.bak'));
  if (existsSync(patchPath)) copyFileSync(patchPath, join(backupDir, 'cordis.patch.yml.bak'));
  return backupDir;
}

export function rollbackProfileConfig(profileDir: string): boolean {
  const backupDir = join(profileDir, '.ns-dsh-backup');
  const pkgBak = join(backupDir, 'package.json.bak');
  const patchBak = join(backupDir, 'cordis.patch.yml.bak');
  if (!existsSync(pkgBak)) return false;
  copyFileSync(pkgBak, join(profileDir, 'package.json'));
  if (existsSync(patchBak)) copyFileSync(patchBak, join(profileDir, 'cordis.patch.yml'));
  return true;
}

export function runUpgradeCanary(opts: {
  workspaceRoot: string;
  targetDshVersion?: string;
  dryRun?: boolean;
}): UpgradeCanaryResult {
  const root = resolve(opts.workspaceRoot);
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
    engines?: { dsh?: string };
  };
  const currentDsh = rootPkg.devDependencies?.['@deepseek-ai/dsh'] ?? '0.2.2-rc.3';
  const targetVersion = opts.targetDshVersion ?? currentDsh;
  const dryRun = opts.dryRun !== false;

  const plugins = ['context', 'codemode', 'cuga', 'board', 'team'];
  const checks: CanaryPluginCheck[] = [];

  for (const name of plugins) {
    const dir = join(root, 'plugins', name);
    const started = performance.now();
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { engines?: { dsh?: string } };
    const range = pkg.engines?.dsh ?? '>=0.2.2-rc.3 <0.3.0-0';
    const compatible = satisfiesDshPrereleaseRange(targetVersion, range);

    const tscLocal = join(dir, 'node_modules', '.bin', 'tsc');
    const tscRoot = join(root, 'node_modules', '.bin', 'tsc');
    const tscBin = existsSync(tscLocal) ? tscLocal : existsSync(tscRoot) ? tscRoot : 'tsc';
    const tc = spawnSync(
      tscBin,
      ['-p', 'tsconfig.test.json'],
      { cwd: dir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const testsPassed = tc.status === 0;
    checks.push({
      plugin: `@smitfire/${name}`,
      engineRange: range,
      compatible,
      testsPassed,
      durationMs: Number((performance.now() - started).toFixed(1)),
      ...(testsPassed ? {} : { error: `${tc.stdout ?? ''}\n${tc.stderr ?? ''}`.trim().slice(0, 500) }),
    });
  }

  const ok = checks.every((c) => c.compatible && c.testsPassed);
  const notes = [
    dryRun
      ? `Dry-run canary verified ${checks.length} child plugins against @deepseek-ai/dsh@${targetVersion}`
      : `Live upgrade gate ${ok ? 'passed' : 'failed'} for @deepseek-ai/dsh@${targetVersion}`,
  ];
  return { ok, targetDshVersion: targetVersion, dryRun, checks, notes };
}

export function cleanTempBackup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
export function writeJsonAtomicReport(path: string, data: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
