#!/usr/bin/env node
/**
 * Revisa lo que está a punto de entrar al repositorio en busca de secretos.
 *
 * Reglas:
 *  - Nunca imprime el valor encontrado: solo archivo, línea y tipo de hallazgo.
 *  - `npm run check-secrets` revisa lo que está en el área de preparación (staged).
 *  - `node tools/check-secrets.mjs --all` audita todos los archivos versionados.
 *
 * Ver docs/SEGURIDAD_SECRETOS.md.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { hallazgosDeLinea, isForbiddenPath } from './lib/secretos.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const readStaged = (path) => execFileSync('git', ['show', `:${path}`], { encoding: 'utf8' });

const readTracked = (path) => readFileSync(path, 'utf8');

const listStaged = () =>
  git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const listTracked = () =>
  git(['ls-files'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** Archivos nuevos que todavía no están versionados ni ignorados por Git. */
const listUntracked = () =>
  git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const listEverything = () => [...new Set([...listTracked(), ...listUntracked()])];

const auditAll = process.argv.includes('--all');

let files;
let reader;
let scope;

try {
  if (auditAll) {
    files = listEverything();
    reader = readTracked;
    scope = 'todos los archivos versionados y nuevos';
  } else {
    files = listStaged();
    reader = readStaged;
    scope = 'archivos en el área de preparación';
    if (files.length === 0) {
      files = listEverything();
      reader = readTracked;
      scope = 'todos los archivos versionados y nuevos (no había nada preparado)';
    }
  }
} catch {
  console.error('check-secrets: no se pudo consultar git (¿estás dentro del repositorio?)');
  process.exit(0);
}

const findings = [];

for (const path of files) {
  if (isForbiddenPath(path)) {
    findings.push({
      path,
      line: 0,
      pattern: 'archivo que nunca debe versionarse (.env, clave o secreto)',
    });
    continue;
  }

  let content;
  try {
    content = reader(path);
  } catch {
    continue;
  }

  if (content.includes('\u0000')) continue; // binario

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of hallazgosDeLinea(line)) {
      findings.push({ path, line: index + 1, pattern });
    }
  });
}

console.log(`check-secrets: revisados ${files.length} archivos (${scope})`);

if (findings.length === 0) {
  console.log('check-secrets: sin secretos detectados ✔');
  process.exit(0);
}

console.error('\ncheck-secrets: se encontraron posibles secretos:\n');
for (const finding of findings) {
  const where = finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
  console.error(`  ✖ ${where} → ${finding.pattern}`);
}
console.error(
  '\nCorrige esto antes de commitear. Si el secreto es real, rótalo (docs/SEGURIDAD_SECRETOS.md §4).\n',
);
process.exit(1);
