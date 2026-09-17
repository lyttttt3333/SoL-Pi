import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const head = '788d8c1e260a4ce8a3b1a06a542a3b3b522d3654';
const patchBase = '7d7f082eeac2530e4e982b947e28af221a19b2e1^';
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
if (!existsSync(shell)) throw new Error(`Missing real Bash: ${shell}`);
const env = {};
for (const key of Object.keys(process.env)) {
  if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all|processor_architecture|number_of_processors)$/i.test(key)) env[key] = process.env[key];
}
Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, '.pi/agent'), CI: 'true', TEST_BASH: shell, npm_config_update_notifier: 'false' });
if (windows) Object.assign(env, { HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) });
const npm = join(dirname(process.execPath), windows ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
if (!existsSync(npm)) throw new Error(`Missing npm CLI: ${npm}`);
const commands = [];
function run(label, command, args, options = {}) {
  console.log(`START ${label}`);
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 240000, maxBuffer: 32 * 1024 * 1024, ...options });
  writeFileSync(join(out, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  commands.push({ label, command: [command, ...args], exitCode: result.status, error: result.error?.message });
  writeFileSync(join(out, 'commands.json'), JSON.stringify(commands, null, 2));
  console.log(`END ${label}: ${result.status}`);
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
writeFileSync(join(out, 'environment.json'), JSON.stringify({ platform: process.platform, node: process.version, shell, versions, base: '2b791687a489a1d24da816cf1634d8ae1d36befd', head }, null, 2));
mkdirSync(join(cwd, '.validation'), { recursive: true });
copyFileSync(join(here, 'probe.mjs'), join(cwd, '.validation/pr35-probe.mjs'));
for (const variant of ['baseline', 'fixed']) {
  if (variant === 'fixed') {
    const patch = run('read-pr-patch', 'git', ['diff', patchBase, head, '--', 'src/sol-pi/extensions/action-fusion/file-queue.ts', 'tests/action-fusion-paths.test.ts']);
    requirePass(patch, 'read patch');
    requirePass(run('apply-pr-patch', 'git', ['apply', '--whitespace=error', '-'], { input: patch.stdout }), 'apply patch');
    const expected = run('pr-source', 'git', ['show', `${head}:src/sol-pi/extensions/action-fusion/file-queue.ts`]);
    requirePass(expected, 'read source');
    const actual = readFileSync(join(cwd, 'src/sol-pi/extensions/action-fusion/file-queue.ts'), 'utf8');
    if (actual.replaceAll('\r\n', '\n') !== expected.stdout.replaceAll('\r\n', '\n')) throw new Error('Patched source differs from PR');
    const expectedTests = run('pr-tests', 'git', ['show', `${head}:tests/action-fusion-paths.test.ts`]);
    requirePass(expectedTests, 'read tests');
    const actualTests = readFileSync(join(cwd, 'tests/action-fusion-paths.test.ts'), 'utf8');
    if (actualTests.replaceAll('\r\n', '\n') !== expectedTests.stdout.replaceAll('\r\n', '\n')) throw new Error('Patched tests differ from PR');
  }
  // Both variants deliberately run even if a probe or existing suite fails,
  // so the retained report separates baseline failures from new regressions.
  run(`${variant}-probe`, process.execPath, ['--experimental-strip-types', '.validation/pr35-probe.mjs', variant], { env: { ...env, PROBE_OUTPUT: join(out, `${variant}-probe.json`) } });
  run(`${variant}-typecheck`, process.execPath, [npm, 'run', 'typecheck']);
  run(`${variant}-paths`, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/action-fusion-paths.test.ts', '--reporter=json', `--outputFile=${join(out, `${variant}-paths.json`)}`]);
  run(`${variant}-tests`, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${join(out, `${variant}-tests.json`)}`]);
  run(`${variant}-public-api`, process.execPath, ['scripts/check-pi-compat.mjs']);
  run(`${variant}-pack`, process.execPath, [npm, 'pack', '--dry-run']);
}
run('audit', process.execPath, [npm, 'audit', '--audit-level=high']);
const failed = commands.filter(command => command.exitCode !== 0);
console.log(JSON.stringify({ failed, results: out }, null, 2));
if (failed.length) process.exitCode = 1;
