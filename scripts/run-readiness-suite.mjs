import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const profile = process.argv[2] ?? 'quick';
const allowedProfiles = new Set(['quick', 'business', 'rc', 'full']);
if (!allowedProfiles.has(profile)) throw new Error(`Неизвестный readiness profile: ${profile}`);

const runId = (process.env['READINESS_RUN_ID'] ?? randomUUID().replaceAll('-', '').slice(0, 12))
  .replace(/[^A-Za-z0-9_-]/g, '')
  .toLowerCase();
const resultDirectory = resolve(
  process.env['READINESS_RESULT_DIR'] ?? `artifacts/readiness/${profile}-${runId}`,
);
const startedAt = new Date();

const stepsByProfile = {
  quick: [
    step('security:check'),
    step('maintainability:report', { environment: { MAINTAINABILITY_ENFORCE: 'true' } }),
    step('lint'),
    step('typecheck'),
    step('contracts:check'),
    step('observability:check'),
    step('adversarial:check', { needsNetworkBind: true }),
    step('readiness:check'),
    step('build'),
  ],
  business: [
    step('security:check'),
    step('maintainability:report', { environment: { MAINTAINABILITY_ENFORCE: 'true' } }),
    step('lint'),
    step('typecheck'),
    step('contracts:check'),
    step('adversarial:check', { needsNetworkBind: true }),
    commandStep('system business e2e', [
      'corepack',
      'pnpm',
      '--filter',
      '@exchange/backend',
      'test',
      '--',
      'test/system.e2e-spec.ts',
      '--runInBand',
    ]),
    step('business:e2e:staging'),
    step('api:flows'),
    step('build'),
  ],
  rc: [
    step('security:check'),
    step('maintainability:report', { environment: { MAINTAINABILITY_ENFORCE: 'true' } }),
    step('lint'),
    step('typecheck'),
    step('contracts:check'),
    step('observability:check'),
    step('adversarial:check', { needsNetworkBind: true }),
    step('readiness:check'),
    commandStep('system business e2e', [
      'corepack',
      'pnpm',
      '--filter',
      '@exchange/backend',
      'test',
      '--',
      'test/system.e2e-spec.ts',
      '--runInBand',
    ]),
    step('business:e2e:staging'),
    step('api:flows'),
    step('load:smoke'),
    step('load:average'),
    step('postgres:backup-restore'),
    step('build'),
  ],
  full: [
    step('security:check'),
    step('maintainability:report', { environment: { MAINTAINABILITY_ENFORCE: 'true' } }),
    step('lint'),
    step('typecheck'),
    step('contracts:check'),
    step('observability:check'),
    step('adversarial:check', { needsNetworkBind: true }),
    step('readiness:check'),
    step('test', { needsNetworkBind: true }),
    step('business:e2e:staging'),
    step('api:flows'),
    step('load:smoke'),
    step('load:average'),
    step('load:spike'),
    step('load:stress'),
    step('load:soak'),
    step('load:breakpoint'),
    step('postgres:backup-restore'),
    step('resilience:staging', {
      environment: { CHAOS_ENVIRONMENT: 'staging', CHAOS_ACK: 'isolated-test-only' },
    }),
    step('build'),
  ],
};

function step(scriptName, options = {}) {
  return commandStep(scriptName, ['corepack', 'pnpm', scriptName], options);
}

function commandStep(name, command, options = {}) {
  return { name, command, ...options };
}

function buildSha() {
  return new Promise((resolveSha) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.once('close', (code) => resolveSha(code === 0 ? output.trim() : 'unknown'));
  });
}

function runStep({ command, environment }) {
  return new Promise((resolveRun) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: resolve('.'),
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.once('error', (error) => resolveRun({ exitCode: 1, output: error.message }));
    child.once('close', (code) => resolveRun({ exitCode: code ?? 1, output }));
  });
}

function needsEscalationNotice(steps) {
  return steps.some((step) => step.needsNetworkBind);
}

function seconds(milliseconds) {
  return Number((milliseconds / 1000).toFixed(2));
}

async function writeReports(report) {
  const rows = report.steps
    .map(
      (step) =>
        `| ${step.status === 'passed' ? '✅' : '❌'} | ${step.name} | ${step.durationSeconds} | ${step.exitCode} |`,
    )
    .join('\n');
  const summary = `## Readiness suite: ${report.profile}\n\n**Status:** ${report.status === 'passed' ? '✅ passed' : '❌ failed'}  \n**Run:** ${report.runId}  \n**Build:** ${report.buildSha}  \n**Duration:** ${report.durationSeconds}s  \n**Artifacts:** \`${resultDirectory}\`\n\n| Status | Step | Duration, s | Exit |\n| --- | --- | ---: | ---: |\n${rows}\n`;
  const junitCases = report.steps
    .map((step) => {
      const failure =
        step.status === 'failed'
          ? `<failure message="${escapeXml(step.error ?? 'step failed')}">${escapeXml(step.tail)}</failure>`
          : '';
      return `<testcase classname="readiness.${escapeXml(report.profile)}" name="${escapeXml(step.name)}" time="${step.durationSeconds}">${failure}</testcase>`;
    })
    .join('');
  const failures = report.steps.filter((step) => step.status === 'failed').length;
  const junit = `<?xml version="1.0" encoding="UTF-8"?><testsuite name="readiness-${escapeXml(report.profile)}" tests="${report.steps.length}" failures="${failures}" time="${report.durationSeconds}">${junitCases}</testsuite>`;
  await mkdir(resultDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(resultDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(resolve(resultDirectory, 'summary.md'), summary),
    writeFile(resolve(resultDirectory, 'junit.xml'), junit),
  ]);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function tail(output) {
  return output.split('\n').slice(-80).join('\n').slice(-8000);
}

async function main() {
  const steps = stepsByProfile[profile];
  if (needsEscalationNotice(steps)) {
    process.stdout.write(
      'Readiness suite содержит Nest/WebSocket e2e. В sandbox окружении может потребоваться запуск с разрешением на локальный bind 127.0.0.1.\n',
    );
  }
  process.stdout.write(`Readiness profile: ${profile}\nArtifacts: ${resultDirectory}\n\n`);

  const results = [];
  for (const current of steps) {
    const stepStartedAt = Date.now();
    process.stdout.write(`\n=== ${current.name} ===\n`);
    const { exitCode, output } = await runStep(current);
    const durationSeconds = seconds(Date.now() - stepStartedAt);
    const status = exitCode === 0 ? 'passed' : 'failed';
    results.push({
      name: current.name,
      command: current.command.join(' '),
      status,
      exitCode,
      durationSeconds,
      tail: tail(output),
      ...(status === 'failed' ? { error: `${current.name} завершился с кодом ${exitCode}` } : {}),
    });
    process.stdout.write(
      `\n${status === 'passed' ? '✓' : '✗'} ${current.name} (${durationSeconds}s)\n`,
    );
    if (status === 'failed' && process.env['READINESS_CONTINUE_ON_FAILURE'] !== 'true') break;
  }

  const finishedAt = new Date();
  const failed = results.some((step) => step.status === 'failed');
  const report = {
    schemaVersion: 1,
    profile,
    runId,
    buildSha: await buildSha(),
    status: failed ? 'failed' : 'passed',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSeconds: seconds(finishedAt.getTime() - startedAt.getTime()),
    continueOnFailure: process.env['READINESS_CONTINUE_ON_FAILURE'] === 'true',
    steps: results,
  };
  await writeReports(report);
  process.stdout.write(`\nReadiness suite ${report.status}. Reports: ${resultDirectory}\n`);
  if (failed) process.exitCode = 1;
}

await main();
