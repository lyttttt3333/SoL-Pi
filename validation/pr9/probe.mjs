import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActionFusionExtension } from '../src/sol-pi/extensions/action-fusion/index.ts';
import { resolveToolPath } from '../src/sol-pi/extensions/action-fusion/file-queue.ts';

const variant = process.argv[2];
assert.ok(['baseline', 'fixed'].includes(variant));
const root = await mkdtemp(join(tmpdir(), 'pr9-native-'));
const homeRoot = await mkdtemp(join(homedir(), 'pr9-home-'));
const tools = new Map();
createActionFusionExtension({ bashOptions: { shellPath: process.env.TEST_BASH } })({ registerTool(tool) { tools.set(tool.name, tool); } });
const cases = [];
const spaces = [0x00a0, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000];
for (const code of spaces) for (const style of ['relative', 'at-relative']) cases.push({ code, style, normalize: true });
for (const style of ['absolute', 'at-absolute', 'home', 'at-home', 'raw-url', 'at-raw-url', 'encoded-url', 'at-encoded-url']) cases.push({ code: 0x00a0, style, normalize: !style.includes('encoded') });
for (const code of [0x0020, 0x1680, 0x200b, 0xfeff]) for (const style of ['relative', 'at-relative']) cases.push({ code, style, normalize: false });
const results = [];
for (const toolName of ['write', 'edit']) {
  for (const item of cases) {
    const { code, style, normalize } = item;
    const character = String.fromCodePoint(code);
    const id = `${toolName}-U${code.toString(16).toUpperCase().padStart(4, '0')}-${style}`;
    const cwd = join(root, id);
    await mkdir(cwd, { recursive: true });
    const directory = style.includes('home') ? join(homeRoot, id) : cwd;
    await mkdir(directory, { recursive: true });
    const inputTarget = join(directory, `target${character}file.txt`);
    const target = join(directory, `target${normalize ? ' ' : character}file.txt`);
    let inputPath;
    switch (style.replace(/^at-/, '')) {
      case 'relative': inputPath = relative(cwd, inputTarget); break;
      case 'absolute': inputPath = inputTarget; break;
      case 'home': inputPath = '~/' + relative(homedir(), inputTarget).replaceAll('\\', '/'); break;
      case 'raw-url': inputPath = pathToFileURL(inputTarget).href.replace(encodeURIComponent(character), character); break;
      case 'encoded-url': inputPath = pathToFileURL(inputTarget).href; break;
      default: throw new Error('Unknown path style');
    }
    if (style.startsWith('at-')) inputPath = '@' + inputPath;
    if (toolName === 'edit') await writeFile(target, 'before\n');
    const marker = join(cwd, 'follow-up.txt');
    const js = `const fs=require("fs");const text=fs.readFileSync(${JSON.stringify(target)},"utf8");if(text!=="after\\n")process.exit(31);fs.writeFileSync(${JSON.stringify(marker)},text);console.log("PR9_FOLLOW_UP_OK");`;
    await writeFile(join(cwd, 'pr9-check.cjs'), js);
    const input = { path: inputPath, ...(toolName === 'write' ? { content: 'after\n' } : { edits: [{ oldText: 'before', newText: 'after' }] }), then_run: { command: 'node pr9-check.cjs', timeout: 20 } };
    const ctx = { cwd, mode: 'json', hasUI: false, ui: {}, sessionManager: { getSessionId: () => id, getSessionFile: () => undefined } };
    let output = '', error;
    try {
      const result = await tools.get(toolName).execute(id, input, undefined, undefined, ctx);
      output = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    } catch (caught) { error = String(caught); }
    const mutationSucceeded = existsSync(target) && await readFile(target, 'utf8') === 'after\n';
    const commandRan = existsSync(marker);
    const expectSkip = variant === 'baseline' && normalize;
    const guardPath = resolveToolPath(cwd, inputPath);
    const pass = mutationSucceeded && (expectSkip
      ? !!error?.includes('[then_run:skipped]') && error.includes('ENOENT') && !commandRan
      : !error && guardPath === target && commandRan && output.includes('[then_run:succeeded]') && output.includes('PR9_FOLLOW_UP_OK') && await readFile(marker, 'utf8') === 'after\n');
    results.push({ id, inputPath, target, guardPath, normalize, expectSkip, mutationSucceeded, commandRan, pass, output, error });
  }
}
const summary = { variant, platform: process.platform, node: process.version, shell: process.env.TEST_BASH, total: results.length, passed: results.filter(row => row.pass).length, results };
await writeFile(process.env.PROBE_OUTPUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.passed !== summary.total) process.exitCode = 1;
