import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface CanaryPluginCheck {
  plugin: string;
  engineRange: string;
  compatible: boolean;
  typecheckPassed: boolean;
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

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre?: string;
}

function parseSemver(raw: string): ParsedSemver | null {
  const m = raw.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const ap = a.pre.split('.');
  const bp = b.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    const an = /^\d+$/.test(ap[i]) ? Number(ap[i]) : ap[i];
    const bn = /^\d+$/.test(bp[i]) ? Number(bp[i]) : bp[i];
    if (an !== bn) {
      if (typeof an === 'number' && typeof bn === 'number') return an - bn;
      if (typeof an === 'number') return -1;
      if (typeof bn === 'number') return 1;
      return an.localeCompare(bn);
    }
  }
  return 0;
}

export function satisfiesDshPrereleaseRange(version: string, range: string): boolean {
  const actual = parseSemver(version);
  if (!actual) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  for (const token of parts) {
    const m = token.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
    if (!m) return false;
    const op = m[1] ?? '=';
    const target = parseSemver(m[2]);
    if (!target) return false;
    const cmp = compareSemver(actual, target);
    if (op === '>=' && cmp < 0) return false;
    else if (op === '<=' && cmp > 0) return false;
    else if (op === '>' && cmp <= 0) return false;
    else if (op === '<' && cmp >= 0) return false;
    else if (op === '=' && cmp !== 0) return false;
    else if (op === '^') {
      if (actual.major !== target.major || cmp < 0) return false;
      if (target.major === 0 && actual.minor !== target.minor) return false;
    } else if (op === '~') {
      if (actual.major !== target.major || actual.minor !== target.minor || cmp < 0) return false;
    }
  }
  return true;
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
  runUnitTests?: boolean;
}): UpgradeCanaryResult {
  const root = resolve(opts.workspaceRoot);
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const currentDsh = rootPkg.devDependencies?.['@deepseek-ai/dsh'] ?? '0.2.2-rc.3';
  const targetVersion = opts.targetDshVersion ?? currentDsh;
  const dryRun = opts.dryRun !== false;

  const plugins = ['context', 'codemode', 'cuga', 'board', 'team'];
  const checks: CanaryPluginCheck[] = [];

  for (const name of plugins) {
    const dir = join(root, 'plugins', name);
    const started = performance.now();
    let range = '>=0.2.2-rc.3 <0.3.0-0';
    let compatible = false;
    let typecheckPassed = false;
    let error: string | undefined;

    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { engines?: { dsh?: string } };
      range = pkg.engines?.dsh ?? range;
      compatible = satisfiesDshPrereleaseRange(targetVersion, range);

      const testCfg = join(dir, 'tsconfig.test.json');
      if (!existsSync(testCfg)) {
        error = `missing ${testCfg}`;
      } else {
        const tscLocal = join(dir, 'node_modules', '.bin', 'tsc');
        const tscRoot = join(root, 'node_modules', '.bin', 'tsc');
        const tscBin = existsSync(tscLocal) ? tscLocal : existsSync(tscRoot) ? tscRoot : 'tsc';
        const tc = spawnSync(
          tscBin,
          ['-p', testCfg],
          { cwd: dir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        typecheckPassed = tc.status === 0;
        if (!typecheckPassed) {
          error = (tc.error ? tc.error.message : `${tc.stdout ?? ''}\n${tc.stderr ?? ''}`).trim().slice(0, 500);
        } else if (opts.runUnitTests) {
          const nt = spawnSync(process.execPath, ['--test', 'test/*.test.ts'], {
            cwd: dir,
            encoding: 'utf8',
            timeout: 60_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          typecheckPassed = nt.status === 0;
          if (!typecheckPassed) error = `${nt.stdout ?? ''}\n${nt.stderr ?? ''}`.trim().slice(0, 500);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    checks.push({
      plugin: `@smitfire/${name}`,
      engineRange: range,
      compatible,
      typecheckPassed,
      durationMs: Number((performance.now() - started).toFixed(1)),
      ...(error ? { error } : {}),
    });
  }

  const ok = checks.every((c) => c.compatible && c.typecheckPassed);
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
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, abs);
}
