#!/usr/bin/env node
/**
 * Borra los artefactos de compilación (`dist/` y `*.tsbuildinfo`) de todo el monorepo.
 *
 * Existe por un fallo real: `tsc -b` es **incremental** (`composite` + `incremental`, con
 * los `.tsbuildinfo` dentro de `dist/`) y puede dar por compilado un proyecto del que —por
 * un cambio previo o un `dist/` a medias— no emitió todos sus módulos. Así, un módulo
 * **nuevo** (p. ej. `services/clinical/src/prescriptions/fit-to-page.ts`) podía quedarse sin
 * su `.js` en `dist/` y el servicio corría con el código viejo: el récipe salía con la letra
 * encogida **y** en dos hojas, y nada en pantalla lo decía. Compilar **en limpio** es lo que
 * garantiza que lo desplegado es exactamente lo que dice el fuente.
 *
 * Lo llama `npm run prebuild` (se ejecuta antes de `build`), así que vale igual para el
 * desarrollo y para los guiones de despliegue (Fedora y Windows), que usan `npm run build`.
 * NO lo llama `typecheck` ni `dev:build`: esos son de desarrollo y quieren el incremental.
 *
 * Es idempotente y **no toca `node_modules`** (solo las raíces de los `workspaces`).
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Los `workspaces` de la raíz (la lista de paquetes, sin nada escrito a mano). */
const leerWorkspaces = () => {
  const pkg = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8'));
  return Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
};

/**
 * Expande un patrón de workspace. Aquí son rutas explícitas, pero un `packages/*` (el otro
 * estilo habitual de npm) también se entiende: el `*` es el nombre de una carpeta hija.
 */
const expandir = (patron) => {
  const estrella = patron.indexOf('*');
  if (estrella === -1) return [patron];
  const base = patron.slice(0, estrella).replace(/\/+$/, '');
  const dir = join(raiz, base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory())
    .map((entrada) => join(base, entrada.name));
};

/** Borra `<ws>/dist` y los `*.tsbuildinfo` sueltos del propio paquete. Devuelve cuántos. */
const limpiarPaquete = (workspace) => {
  const dir = join(raiz, workspace);
  if (!existsSync(dir)) return 0;

  let borrados = 0;
  const dist = join(dir, 'dist');
  if (existsSync(dist)) {
    rmSync(dist, { recursive: true, force: true });
    borrados += 1;
  }
  // Un `.tsbuildinfo` **fuera** de `dist/` (si algún `tsconfig` lo moviera) dejaría al
  // incremental «creyendo» que ya compiló: se quita también.
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.isFile() && entrada.name.endsWith('.tsbuildinfo')) {
      rmSync(join(dir, entrada.name), { force: true });
      borrados += 1;
    }
  }
  return borrados;
};

const paquetes = leerWorkspaces().flatMap(expandir);
let conArtefactos = 0;
let artefactos = 0;
for (const paquete of paquetes) {
  const borrados = limpiarPaquete(paquete);
  if (borrados > 0) {
    conArtefactos += 1;
    artefactos += borrados;
  }
}

console.log(
  `limpiar-dist: ${String(artefactos)} artefacto(s) de compilación en ${String(conArtefactos)} paquete(s)`,
);
