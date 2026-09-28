#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const rootDirectory = resolve(import.meta.dirname, '..');
const expectedSeed = 20260928;
const rootManifest = JSON.parse(readFileSync(resolve(rootDirectory, 'package.json'), 'utf8'));
function inspect(options) {
  const result = spawnSync(
    'corepack',
    [
      'pnpm',
      '--filter',
      '@exchange/backend',
      'exec',
      'jest',
      '--selectProjects',
      'e2e',
      ...options,
      '--showConfig',
    ],
    { cwd: rootDirectory, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Jest config inspection failed.\n');
    process.exit(result.status ?? 1);
  }
  const jsonStart = result.stdout.indexOf('{\n  "configs"');
  if (jsonStart < 0) {
    process.stderr.write(`Jest --showConfig did not return JSON:\n${result.stdout}`);
    process.exit(1);
  }
  return JSON.parse(result.stdout.slice(jsonStart)).globalConfig;
}

const actual = inspect([
  '--runInBand',
  '--testTimeout=15000',
  '--randomize',
  `--seed=${expectedSeed}`,
  '--showSeed',
]);
const workerConfig = inspect(['--maxWorkers=2']);
const assertions = [
  ['runInBand/maxWorkers', actual.maxWorkers === 1],
  ['maxWorkers', workerConfig.maxWorkers === 2],
  ['testTimeout', actual.testTimeout === 15000],
  ['randomize', actual.randomize === true],
  ['seed', actual.seed === expectedSeed],
  ['showSeed', actual.showSeed === true],
  ['no test-pattern leakage', actual.nonFlagArgs.length === 0],
];
const failed = assertions.filter(([, passed]) => !passed).map(([name]) => name);
process.stdout.write(
  `${JSON.stringify({
    check: 'jest-options',
    passed: failed.length === 0,
    options: {
      runInBand: actual.maxWorkers === 1,
      maxWorkers: workerConfig.maxWorkers,
      testTimeout: actual.testTimeout,
      randomize: actual.randomize,
      seed: actual.seed,
      showSeed: actual.showSeed,
      nonFlagArgs: actual.nonFlagArgs,
    },
  })}\n`,
);
if (failed.length > 0) {
  process.stderr.write(`Jest did not apply required options: ${failed.join(', ')}\n`);
  process.exit(1);
}

const targetedScripts = [
  ['observability:check', '--selectProjects unit', '--runTestsByPath'],
  ['chaos:component', '--selectProjects component', '--runTestsByPath'],
];
for (const [name, projectSelection, pathSelection] of targetedScripts) {
  const command = rootManifest.scripts?.[name] ?? '';
  if (!command.includes(' exec jest ') || !command.includes(projectSelection) || !command.includes(pathSelection)) {
    process.stderr.write(
      `${name} must call Jest directly with an explicit project and --runTestsByPath.\n`,
    );
    process.exit(1);
  }
}

const require = createRequire(import.meta.url);
const RequiredReporter = require('./jest-required-reporter.cjs');
const skippedResult = {
  numPassedTestSuites: 0,
  numFailedTestSuites: 0,
  numPendingTestSuites: 1,
  numTotalTestSuites: 1,
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 1,
  numTotalTests: 1,
};
const requiredReporter = new RequiredReporter({
  seed: expectedSeed,
  randomize: true,
  suppressSummary: true,
});
requiredReporter.onRunComplete(new Set(), skippedResult);
if (!requiredReporter.getLastError()) {
  process.stderr.write('Mandatory Jest reporter accepted skipped coverage.\n');
  process.exit(1);
}
