#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '..');
const tag = `exchange-clean-checkout:${process.pid}`;

function run(command, args, stdio = 'inherit') {
  return spawnSync(command, args, {
    cwd: rootDirectory,
    env: process.env,
    stdio,
    encoding: 'utf8',
  });
}

function required(command, args) {
  const result = run(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

const docker = run('docker', ['info', '--format', '{{.ServerVersion}}'], 'pipe');
if (docker.status !== 0) {
  process.stderr.write('clean-checkout:check requires a running Docker engine.\n');
  process.exit(1);
}

try {
  required('docker', [
    'buildx',
    'build',
    '--target',
    'clean-checkout',
    '--load',
    '--provenance=false',
    '--sbom=false',
    '--tag',
    tag,
    '.',
  ]);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    process.stdout.write(`Clean Node 22 container verification ${attempt}/2\n`);
    required('docker', [
      'run',
      '--rm',
      tag,
      'pnpm',
      '--filter',
      '@exchange/contracts',
      'test',
      '--runInBand',
    ]);
    required('docker', [
      'run',
      '--rm',
      tag,
      'pnpm',
      '--filter',
      '@exchange/backend',
      'test',
      '--maxWorkers=2',
      '--testTimeout=15000',
      '--showSeed',
    ]);
    required('docker', ['run', '--rm', tag, 'pnpm', 'build']);
  }
  process.stdout.write('Clean-checkout tests and build passed twice in Node 22 containers.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  run('docker', ['image', 'rm', '--force', tag], 'ignore');
}
