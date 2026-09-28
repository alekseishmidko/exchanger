#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDirectory = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(rootDirectory, 'package.json'), 'utf8'));
const expectedNode = String(manifest.engines.node);
const expectedPnpm = String(manifest.packageManager).replace(/^pnpm@/, '');
const actualNode = process.versions.node;
const pnpm = spawnSync('corepack', ['pnpm', '--version'], {
  cwd: rootDirectory,
  encoding: 'utf8',
});
const actualPnpm = pnpm.status === 0 ? pnpm.stdout.trim() : 'unavailable';
const report = {
  node: { expected: expectedNode, actual: process.version },
  pnpm: { expected: expectedPnpm, actual: actualPnpm },
};
process.stdout.write(`TOOLCHAIN ${JSON.stringify(report)}\n`);

if (actualNode !== expectedNode || actualPnpm !== expectedPnpm) {
  process.stderr.write(
    `Toolchain mismatch: expected Node ${expectedNode} / pnpm ${expectedPnpm}; got ${process.version} / ${actualPnpm}. Run nvm install && nvm use before verify:local.\n`,
  );
  process.exit(1);
}
