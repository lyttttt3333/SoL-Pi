import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActionFusionExtension } from '../src/sol-pi/extensions/action-fusion/index.ts';
import { resolveToolPath } from '../src/sol-pi/extensions/action-fusion/file-queue.ts';

const variant = process.argv[2];
assert.ok(['baseline', 'fixed'].includes(variant));
const windows = process.platform === 'win32';
const root = await mkdtemp(join(tmpdir(), 'pr35-native-'));
const homeRoot = await mkdtemp(join(homedir(), 'pr35-home-'));
const results = [];
const tools = new Map();
createActionFusionExtension({ bashOptions: { shellPath: process.env.TEST_BASH } })({ registerTool(tool) { tools.set(tool.name, tool); } });
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
function shellPath(path, prefix) {
  assert.match(path, /^[a-z]:\\/i);
  return `/${prefix}${path[0].toLowerCase()}/${path.slice(3).replaceAll('\\', '/')}`;
}
const cases = ['relative', 'at-relative', 'native', 'file-url', 'at-file-url', 'home-slash'];
if (windows) cases.push('git-bash', 'at-git-bash', 'wsl-path', 'at-wsl-path', 'cygwin-path', 'at-cygwin-path', 'home-backslash', 'at-home-backslash');
else cases.push('posix-backslash');

for (const toolName of ['write', 'edit']) {
  for (const kind of cases) {
    const id = `${toolName}-${kind}`;
    const cwd = join(root, id);
    await mkdir(cwd, { recursive: true });
    const inHome = kind.includes('home-');
    const target = inHome ? join(homeRoot, id, 'target file.txt') : join(cwd, kind === 'posix-backslash' ? '~\\notes.txt' : 'target file.txt');
    await mkdir(dirname(target), { recursive: true });
    const marker = join(cwd, 'follow-up.txt');
    let inputPath;
    switch (kind) {
      case 'relative': inputPath = relative(cwd, target); break;
      case 'at-relative': inputPath = '@' + relative(cwd, target); break;
      case 'native': inputPath = target; break;
      case 'file-url': inputPath = pathToFileURL(target).href; break;
      case 'at-file-url': inputPath = '@' + pathToFileURL(target).href; break;
      case 'home-slash': inputPath = '~/' + relative(homedir(), target).replaceAll('\\', '/'); break;
      case 'home-backslash': case 'at-home-backslash': inputPath = (kind.startsWith('at-') ? '@' : '') + '~\\' + relative(homedir(), target); break;
      case 'posix-backslash': inputPath = '~\\notes.txt'; break;
      default: inputPath = (kind.startsWith('at-') ? '@' : '') + shellPath(target, kind.includes('wsl') ? 'mnt/' : kind.includes('cygwin') ? 'cygdrive/' : '');
    }
    const affected = windows && ['git-bash', 'wsl-path', 'cygwin-path', 'home-backslash'].some(name => kind.endsWith(name));
    const expectSkip = variant === 'baseline' && affected;
    if (toolName === 'edit') await writeFile(target, 'before\n');
    const js = `const fs=require("fs");const text=fs.readFileSync(${JSON.stringify(target)},"utf8");if(text!=="after\\n")process.exit(31);fs.writeFileSync(${JSON.stringify(marker)},text);console.log("PR35_FOLLOW_UP_OK");`;
    const input = { path: inputPath, ...(toolName === 'write' ? { content: 'after\n' } : { edits: [{ oldText: 'before', newText: 'after' }] }), then_run: { command: `node -e ${quote(js)}`, timeout: 20 } };
    const ctx = { cwd, mode: 'json', hasUI: false, ui: {}, sessionManager: { getSessionId: () => id, getSessionFile: () => undefined } };
    let output = '', error;
    try {
      const result = await tools.get(toolName).execute(id, input, undefined, undefined, ctx);
      output = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    } catch (caught) { error = String(caught); }
    const content = existsSync(target) ? await readFile(target, 'utf8') : undefined;
    const commandRan = existsSync(marker);
    const pass = content === 'after\n' && (expectSkip
      ? !!error?.includes('[then_run:skipped]') && error.includes('ENOENT') && !commandRan
      : !error && commandRan && output.includes('[then_run:succeeded]') && output.includes('PR35_FOLLOW_UP_OK') && await readFile(marker, 'utf8') === 'after\n');
    results.push({ id, inputPath, target, guardPath: resolveToolPath(cwd, inputPath), affected, expectSkip, mutationSucceeded: content === 'after\n', commandRan, pass, output, error });
  }
}
if (!windows) {
  for (const path of ['/c/src/app.ts', '/mnt/c/src/app.ts', '/cygdrive/c/src/app.ts']) {
    results.push({ id: `posix-resolver:${path}`, pass: resolveToolPath(root, path) === path });
  }
}
const summary = { variant, platform: process.platform, node: process.version, shell: process.env.TEST_BASH, root, homeRoot, total: results.length, passed: results.filter(row => row.pass).length, results };
await writeFile(process.env.PROBE_OUTPUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.passed !== summary.total) process.exitCode = 1;
