import { execFileSync } from 'node:child_process';

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const forbiddenFiles = trackedFiles.filter((file) =>
  /(^|\/)(node_modules|dist|coverage)(\/|$)|(^|\/)(\.env|.*\.(pem|key))$/.test(file),
);

const sourceFiles = trackedFiles.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file));

const deepImports = sourceFiles.filter((file) => {
  const content = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8' });
  return (
    /from\s+['"](?:@exchange\/[^'"]+|\.\.\/[^'"]*packages\/[^'"]+)\/src\//.test(content) ||
    /require\(\s*['"](?:@exchange\/[^'"]+|\.\.\/[^'"]*packages\/[^'"]+)\/src\//.test(content)
  );
});

if (forbiddenFiles.length > 0) {
  console.error('Forbidden tracked files:', forbiddenFiles.join('\n'));
}

if (deepImports.length > 0) {
  console.error('Potential deep imports detected in:', deepImports.join('\n'));
}

if (forbiddenFiles.length > 0 || deepImports.length > 0) {
  process.exitCode = 1;
} else {
  console.log('Repository security checks passed.');
}
