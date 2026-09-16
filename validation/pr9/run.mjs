import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const head = '8c46b7631b372ab4bb6fcd04015f4d514f0bac25';
const base = '2b791687a489a1d24da816cf1634d8ae1d36befd';
const here = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
const version = process.argv[4];
if (!['0.84.2', '0.85.1'].includes(version)) throw new Error('Unsupported Pi version');
mkdirSync(out, { recursive: true });
const home = join(out, 'home');
mkdirSync(home, { recursive: true });
const windows = process.platform === 'win32';
const shell = windows ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
if (!existsSync(shell)) throw new Error(`Missing Bash: ${shell}`);
const env = {};
for (const key of Object.keys(process.env)) {
  if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all|processor_architecture|number_of_processors)$/i.test(key)) env[key] = process.env[key];
}
Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, '.pi/agent'), CI: 'true', TEST_BASH: shell, npm_config_update_notifier: 'false' });
if (windows) Object.assign(env, { HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) });
const npm = join(dirname(process.execPath), windows ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
if (!existsSync(npm)) throw new Error(`Missing npm CLI: ${npm}`);
const commands = [];
function run(label, command, args, options = {}, expectedExitCode = 0) {
  console.log(`START ${label}`);
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...options });
  writeFileSync(join(out, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  commands.push({ label, command: [command, ...args], exitCode: result.status, expectedExitCode, error: result.error?.message });
  writeFileSync(join(out, 'commands.json'), JSON.stringify(commands, null, 2));
  console.log(`END ${label}: ${result.status} (expected ${expectedExitCode})`);
  return result;
}
function requirePass(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-3000)}`);
}
requirePass(run('fetch-pr', 'git', ['fetch', '--no-tags', 'https://github.com/NVlabs/SoL-Pi.git', head]), 'fetch');
const pkgPath = join(cwd, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (version === '0.84.2') {
  for (const name of Object.keys(pkg.devDependencies)) if (name.startsWith('@earendil-works/pi-')) pkg.devDependencies[name] = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
  const guide = join(cwd, 'agents-install.md');
  writeFileSync(guide, readFileSync(guide, 'utf8').replaceAll('0.85.1', version));
  requirePass(run('lockfile', process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit']), 'lockfile');
}
requirePass(run('install', process.execPath, [npm, 'ci', '--ignore-scripts']), 'install');
const versions = {};
for (const name of ['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui']) {
  versions[name] = JSON.parse(readFileSync(join(cwd, 'node_modules/@earendil-works', name, 'package.json'), 'utf8')).version;
  if (versions[name] !== version) throw new Error('Wrong Pi dependency version');
}
writeFileSync(join(out, 'environment.json'), JSON.stringify({ platform: process.platform, node: process.version, shell, versions, base, head }, null, 2));
mkdirSync(join(cwd, '.validation'), { recursive: true });
copyFileSync(join(here, 'probe.mjs'), join(cwd, '.validation/pr9-probe.mjs'));
function applyFile(file, label) {
  const patch = run(`read-${label}-patch`, 'git', ['diff', `${head}^`, head, '--', file]);
  requirePass(patch, 'read patch');
  requirePass(run(`apply-${label}-patch`, 'git', ['apply', '--whitespace=error', '-'], { input: patch.stdout }), 'apply patch');
  const expected = run(`${label}-pr-content`, 'git', ['show', `${head}:${file}`]);
  requirePass(expected, 'read PR file');
  if (readFileSync(join(cwd, file), 'utf8').replaceAll('\r\n', '\n') !== expected.stdout.replaceAll('\r\n', '\n')) throw new Error(`Patched ${file} differs from PR`);
}
function tests(variant, extra = [], expectedExitCode = 0) {
  return run(`${variant}-tests`, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...extra, '--reporter=json', `--outputFile=${join(out, `${variant}-tests.json`)}`], {}, expectedExitCode);
}
// Negative controls deliberately precede the patch. Every exit code and assertion
// report is retained; unrelated baseline suite failures still make the job fail.
for (const variant of ['baseline', 'new-tests-old-code', 'fixed']) {
  if (variant === 'new-tests-old-code') {
    applyFile('tests/action-fusion-paths.test.ts', 'tests');
    tests(variant, ['tests/action-fusion-paths.test.ts'], 1);
    const report = JSON.parse(readFileSync(join(out, `${variant}-tests.json`), 'utf8'));
    const failed = report.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed'));
    if (failed.length !== 8 || failed.some(test => !/normalizes Unicode space|through a Unicode-space path/.test(test.fullName))) throw new Error('New tests did not fail as expected against old code');
    continue;
  }
  if (variant === 'fixed') applyFile('src/sol-pi/extensions/action-fusion/file-queue.ts', 'source');
  run(`${variant}-probe`, process.execPath, ['--experimental-strip-types', '.validation/pr9-probe.mjs', variant], { env: { ...env, PROBE_OUTPUT: join(out, `${variant}-probe.json`) } });
  run(`${variant}-typecheck`, process.execPath, [npm, 'run', 'typecheck']);
  tests(variant);
  run(`${variant}-public-api`, process.execPath, ['scripts/check-pi-compat.mjs']);
  run(`${variant}-pack`, process.execPath, [npm, 'pack', '--dry-run']);
}
run('audit', process.execPath, [npm, 'audit', '--audit-level=high']);
const failed = commands.filter(command => command.exitCode !== command.expectedExitCode);
console.log(JSON.stringify({ failed, results: out }, null, 2));
if (failed.length) process.exitCode = 1;
