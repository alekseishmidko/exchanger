import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = 'apps/backend/dist';
if (!existsSync(root)) throw new Error('Production artifact is missing; run build first');

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(root);

const forbiddenFiles = files.filter((file) => /(?:\.map$|\.spec\.|\.test\.|fixture|__tests__)/i.test(file));
const forbiddenPatterns = [
  /AUTH_TEST_BYPASS_ENABLED\s*[=:]\s*['"]?true/i,
  /GATEWAY_API_KEYS\s*[=:]/,
  /dev-admin-key|dev-key/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const findings = [];
for (const file of files) {
  if (!/\.(?:js|json|txt)$/.test(file)) continue;
  const content = readFileSync(file, 'utf8');
  for (const pattern of forbiddenPatterns)
    if (pattern.test(content)) findings.push(`${relative(root, file)}: ${pattern}`);
}

if (forbiddenFiles.length || findings.length) {
  process.stderr.write(
    `Unsafe production artifact:\n${[...forbiddenFiles.map((file) => relative(root, file)), ...findings].join('\n')}\n`,
  );
  process.exitCode = 1;
} else process.stdout.write(`Production artifact security check passed (${files.length} files).\n`);
