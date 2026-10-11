#!/usr/bin/env node
/**
 * Escribe `.odontocrm-build-commit` con el commit que se acaba de compilar.
 *
 * Es la marca que usa `odontocrm verificar` (Fedora) y `40-verificar.ps1` (Windows) para
 * avisar cuando el `dist` desplegado **no** es el del código que hay en el disco: un
 * `git reset --hard` o un `git checkout` en `/opt/odontocrm` cambia el **fuente** pero **no
 * recompila**, y el servicio sigue corriendo el código viejo sin que nadie se entere hasta
 * que algo falla en el papel. Pasó de verdad: el récipe salió encogido y en dos hojas
 * exactamente por eso.
 *
 * Lo llama `npm run postbuild`. Si no hay git (o no es un repositorio), deja la marca vacía
 * y el aviso simplemente no salta.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const commitDe = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: raiz, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const commit = commitDe();
writeFileSync(join(raiz, '.odontocrm-build-commit'), `${commit}\n`);
console.log(`marcar-build: commit ${commit === '' ? '(sin git)' : commit}`);
