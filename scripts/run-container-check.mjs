#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const tag = `exchange-backend:local-check-${process.pid}`;
const trivyImage =
  'aquasec/trivy:0.70.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e';

/** Выполняет команду без shell interpolation и наследует диагностический вывод. */
function run(command, args, stdio = 'inherit') {
  return spawnSync(command, args, { cwd: repositoryRoot, stdio, encoding: 'utf8' });
}

const dockerProbe = run('docker', ['info', '--format', '{{.ServerVersion}}'], 'pipe');
if (dockerProbe.error || dockerProbe.status !== 0) {
  process.stderr.write(
    'container:check requires a running Docker engine. Start Docker Desktop and retry.\n',
  );
  process.exit(1);
}

const buildxProbe = run('docker', ['buildx', 'version'], 'pipe');
if (buildxProbe.error || buildxProbe.status !== 0) {
  process.stderr.write('container:check requires the Docker Buildx plugin.\n');
  process.exit(1);
}

/** Повторяет локально GitHub Trivy filesystem/IaC scan до сборки образа. */
const filesystemScan = run('docker', [
  'run',
  '--rm',
  '--env',
  'TRIVY_DISABLE_VEX_NOTICE=true',
  '--volume',
  `${repositoryRoot}:/workspace:ro`,
  '--volume',
  'exchange-trivy-cache:/root/.cache/trivy',
  trivyImage,
  'fs',
  '--severity',
  'HIGH,CRITICAL',
  '--exit-code',
  '1',
  '--skip-dirs',
  '/workspace/.git',
  '--skip-dirs',
  '/workspace/artifacts',
  '--skip-dirs',
  '/workspace/node_modules',
  '--skip-dirs',
  '/workspace/apps/backend/dist',
  '--skip-dirs',
  '/workspace/apps/frontend/dist',
  '--skip-version-check',
  '/workspace',
]);

if (filesystemScan.status !== 0) {
  process.exit(filesystemScan.status ?? 1);
}

const build = run('docker', [
  'buildx',
  'build',
  '--target',
  'production',
  '--load',
  '--provenance=false',
  '--sbom=false',
  '--tag',
  tag,
  '.',
]);

if (build.status === 0) {
  const user = run('docker', ['image', 'inspect', '--format', '{{.Config.User}}', tag], 'pipe');
  if (user.status !== 0 || user.stdout.trim() !== 'node') {
    process.stderr.write('Production image must run as the non-root node user.\n');
    process.exitCode = 1;
  } else {
    const runtime = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      tag,
      '-c',
      'test -f dist/main.js && node -e "require(\'@exchange/contracts\')"',
    ]);
    const packageManagers = run(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        tag,
        '-c',
        'command -v npm || command -v yarn || command -v corepack',
      ],
      'pipe',
    );
    if (runtime.status !== 0) {
      process.stderr.write(
        'Production image is missing a runnable backend artifact or workspace dependency.\n',
      );
      process.exitCode = runtime.status ?? 1;
    } else if (packageManagers.status === 0) {
      process.stderr.write(
        `Production image contains a package manager: ${packageManagers.stdout.trim()}\n`,
      );
      process.exitCode = 1;
    } else {
      const scan = run('docker', [
        'run',
        '--rm',
        '--env',
        'TRIVY_DISABLE_VEX_NOTICE=true',
        '--volume',
        '/var/run/docker.sock:/var/run/docker.sock',
        '--volume',
        'exchange-trivy-cache:/root/.cache/trivy',
        trivyImage,
        'image',
        '--severity',
        'HIGH,CRITICAL',
        '--exit-code',
        '1',
        '--table-mode',
        'detailed',
        '--skip-version-check',
        tag,
      ]);
      if (scan.status !== 0) {
        process.exitCode = scan.status ?? 1;
      } else {
        process.stdout.write(
          'Production container build, hardening, and vulnerability checks passed.\n',
        );
      }
    }
  }
} else {
  process.exitCode = build.status ?? 1;
}

if (build.status === 0) run('docker', ['image', 'rm', '--force', tag], 'ignore');
