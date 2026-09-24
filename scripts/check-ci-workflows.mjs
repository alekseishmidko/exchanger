#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const failures = [];

/** Возвращает YAML-блок шага по его имени до следующего шага. */
function stepBlock(name) {
  const marker = `- name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

const imageBuild = stepBlock('Build production image for vulnerability scan');
if (!imageBuild) failures.push('Production image scan build step is missing');
if (!/\bload:\s*true\b/.test(imageBuild)) failures.push('Scan image must be loaded into Docker');
if (!/\bprovenance:\s*false\b/.test(imageBuild) || !/\bsbom:\s*false\b/.test(imageBuild))
  failures.push('Docker --load scan build must disable manifest-list attestations');

const secretScan = stepBlock('Secret scanning');
if (!/GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/.test(secretScan))
  failures.push('Gitleaks PR scan must receive GITHUB_TOKEN');
if (!/fetch-depth:\s*0/.test(workflow)) failures.push('Secret scan requires full Git history');
if (!/run:\s*pnpm redis:check/.test(workflow))
  failures.push('CI must use the same redis:check command as local development');

if (failures.length > 0) {
  process.stderr.write(`CI workflow contract failed:\n${failures.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('CI workflow contract checks passed.\n');
}
