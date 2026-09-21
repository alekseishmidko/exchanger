import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => /^(apps|packages)\/.*\.(ts|js|mjs)$/.test(file) && existsSync(file));

const rows = files
  .map((file) => {
    const lines = readFileSync(file, 'utf8').split('\n').length;
    const isTest = /(?:\.spec|-spec|\.e2e-spec|\/test\/)/.test(file);
    return { file, lines, isTest };
  })
  .sort((left, right) => right.lines - left.lines);

const productionLimit = Number(process.env['MAINTAINABILITY_PRODUCTION_LIMIT'] ?? 600);
const testLimit = Number(process.env['MAINTAINABILITY_TEST_LIMIT'] ?? 800);
const offenders = rows.filter(
  ({ lines, isTest }) => lines > (isTest ? testLimit : productionLimit),
);

process.stdout.write('Maintainability report: largest files\n');
for (const { file, lines, isTest } of rows.slice(0, 25)) {
  process.stdout.write(`${String(lines).padStart(5, ' ')} ${isTest ? 'test ' : 'prod '} ${file}\n`);
}

if (offenders.length > 0) {
  process.stdout.write('\nFiles above current soft limit:\n');
  for (const { file, lines, isTest } of offenders) {
    process.stdout.write(
      `${String(lines).padStart(5, ' ')} > ${isTest ? testLimit : productionLimit} ${file}\n`,
    );
  }
}

if (process.env['MAINTAINABILITY_ENFORCE'] === 'true' && offenders.length > 0) {
  process.exitCode = 1;
}
