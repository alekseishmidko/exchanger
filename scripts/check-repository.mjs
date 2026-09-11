import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const forbiddenFiles = trackedFiles.filter((file) =>
  /(^|\/)(node_modules|dist|coverage)(\/|$)|(^|\/)(\.env|.*\.(pem|key))$/.test(file),
);

const sourceFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file));

const deepImports = sourceFiles.filter((file) => {
  const content = readFileSync(file, 'utf8');
  return (
    /from\s+['"](?:@exchange\/[^'"]+|\.\.\/[^'"]*packages\/[^'"]+)\/src\//.test(content) ||
    /require\(\s*['"](?:@exchange\/[^'"]+|\.\.\/[^'"]*packages\/[^'"]+)\/src\//.test(content)
  );
});

const consoleUsage = sourceFiles.filter((file) => {
  const content = readFileSync(file, 'utf8');
  return /\bconsole\.(?:log|error|warn|info|debug)\s*\(/.test(content);
});

if (forbiddenFiles.length > 0) {
  process.stderr.write(`Forbidden tracked files:\n${forbiddenFiles.join('\n')}\n`);
}

if (deepImports.length > 0) {
  process.stderr.write(`Potential deep imports detected in:\n${deepImports.join('\n')}\n`);
}

if (consoleUsage.length > 0) {
  process.stderr.write(`Direct console output detected in:\n${consoleUsage.join('\n')}\n`);
}

if (forbiddenFiles.length > 0 || deepImports.length > 0 || consoleUsage.length > 0) {
  process.exitCode = 1;
} else {
  process.stdout.write('Repository security checks passed.\n');
}
