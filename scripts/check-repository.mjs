import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

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
  .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file))
  .filter((file) => existsSync(file) && statSync(file).isFile());

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

const browserCredentialStorage = sourceFiles.filter((file) => {
  const content = readFileSync(file, 'utf8');
  return /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\([^\n]*(?:api.?key|token|password)/i.test(
    content,
  );
});

const securitySuppressionsWithoutExpiry = trackedFiles.filter((file) => {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const content = readFileSync(file, 'utf8');
  return content.split('\n').some((line) => {
    if (!/(?:nosemgrep|gitleaks:allow|trivy:ignore|#nosec)/i.test(line)) return false; // owner=security reason=policy-definition expires=2099-01-01
    return !/owner=[A-Za-z0-9._/-]+\s+reason=\S+\s+expires=\d{4}-\d{2}-\d{2}/.test(line);
  });
});

const productionDockerfile = readFileSync('Dockerfile', 'utf8');
const insecureProductionImage = !/FROM node:[^\n]+ AS production[\s\S]*\nUSER node\n/.test(
  productionDockerfile,
);
const productionCompose = readFileSync('docker-compose.production.yml', 'utf8');
const unpinnedProductionImages = [...productionCompose.matchAll(/^\s*image:\s*["']?([^\n"']+)/gm)]
  .map((match) => match[1])
  .filter((image) => !image.includes('@sha256:'));
const unpinnedNodeImage = !/^FROM node:[^\n]+@sha256:[a-f0-9]{64} AS production$/m.test(
  productionDockerfile,
);
const unprunedRuntimeDependencies =
  !/^RUN pnpm --filter @exchange\/backend --prod deploy --legacy \/production\/backend$/m.test(
    productionDockerfile,
  ) || /COPY[^\n]*\/workspace\/node_modules/m.test(productionDockerfile);
const backendSection = productionCompose.slice(
  productionCompose.indexOf('\n  backend:'),
  productionCompose.indexOf('\n  ingress:'),
);
const backendPublishesOrigin = /^ {4}ports:/m.test(backendSection);
const missingContainerHardening = ![
  /read_only:\s*true/,
  /cap_drop:\s*\n\s*- ALL/,
  /no-new-privileges:true/,
  /pids_limit:/,
  /mem_limit:/,
  /cpus:/,
].every((pattern) => pattern.test(productionCompose));

if (forbiddenFiles.length > 0) {
  process.stderr.write(`Forbidden tracked files:\n${forbiddenFiles.join('\n')}\n`);
}

if (deepImports.length > 0) {
  process.stderr.write(`Potential deep imports detected in:\n${deepImports.join('\n')}\n`);
}

if (consoleUsage.length > 0) {
  process.stderr.write(`Direct console output detected in:\n${consoleUsage.join('\n')}\n`);
}
if (browserCredentialStorage.length > 0) {
  process.stderr.write(
    `Reusable browser credential storage detected in:\n${browserCredentialStorage.join('\n')}\n`,
  );
}
if (securitySuppressionsWithoutExpiry.length > 0)
  process.stderr.write(
    `Security suppressions require owner, reason and expiry:\n${securitySuppressionsWithoutExpiry.join('\n')}\n`,
  );
if (insecureProductionImage) process.stderr.write('Production image must run as non-root user.\n');
if (unpinnedProductionImages.length > 0 || unpinnedNodeImage)
  process.stderr.write('Production images must be pinned by sha256 digest.\n');
if (unprunedRuntimeDependencies)
  process.stderr.write('Production image dependencies must be pruned to production-only graph.\n');
if (backendPublishesOrigin)
  process.stderr.write('Production backend origin must not publish a host port.\n');
if (missingContainerHardening)
  process.stderr.write('Production container hardening policy is incomplete.\n');

if (
  forbiddenFiles.length > 0 ||
  deepImports.length > 0 ||
  consoleUsage.length > 0 ||
  browserCredentialStorage.length > 0 ||
  securitySuppressionsWithoutExpiry.length > 0 ||
  insecureProductionImage ||
  unpinnedProductionImages.length > 0 ||
  unpinnedNodeImage ||
  unprunedRuntimeDependencies ||
  backendPublishesOrigin ||
  missingContainerHardening
) {
  process.exitCode = 1;
} else {
  process.stdout.write('Repository security checks passed.\n');
}
