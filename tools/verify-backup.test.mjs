import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TABLA_DE_CONTROL } from './verify-backup.mjs';

/**
 * El mapa de tablas de control del simulacro de restauración.
 *
 * Es la única parte de `tools/verify-backup.mjs` que puede quedarse **vieja en silencio**: si
 * alguien renombra `clinical_sessions`, el simulacro seguiría restaurando bien y fallaría al
 * contar —y ese fallo se leería como «el respaldo está malo», que es una falsa alarma de las
 * caras—. Aquí se comprueba contra el `schema.ts` del servicio dueño de cada base: la
 * fuente de verdad de los nombres de tabla.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Servicios con base propia (los que tienen `migrations/`). */
const servicios = () =>
  readdirSync(join(ROOT, 'services'), { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory())
    .map((entrada) => entrada.name)
    .filter((nombre) => existsSync(join(ROOT, 'services', nombre, 'migrations')));

/** Nombres de tabla declarados en el esquema Drizzle de un servicio. */
const tablasDe = (servicio) => {
  const ruta = join(ROOT, 'services', servicio, 'src', 'db', 'schema.ts');
  if (!existsSync(ruta)) return null;
  const fuente = readFileSync(ruta, 'utf8');
  // `pgTable('nombre')` y `pgTable(\n  'nombre',` son las dos formas que usa el repositorio.
  return [...fuente.matchAll(/pgTable\(\s*'([a-z_]+)'/g)].map((coincidencia) => coincidencia[1]);
};

describe('las tablas de control del simulacro', () => {
  it('cada base del sistema tiene su tabla declarada', () => {
    // Con `odonto_events` aparte: su base es de pg-boss y no tiene servicio dueño.
    const conBase = servicios().map((nombre) => `odonto_${nombre}`);
    const sinControl = conBase.filter((base) => TABLA_DE_CONTROL[base] === undefined);
    expect(sinControl).toEqual([]);
  });

  it('cada tabla de control existe en el esquema de su servicio', () => {
    for (const [base, control] of Object.entries(TABLA_DE_CONTROL)) {
      if (base === 'odonto_events') continue; // la cola: `pgboss.job`, de pg-boss

      const servicio = base.replace(/^odonto_/, '');
      const tablas = tablasDe(servicio);
      expect(tablas, `no encontré el esquema de ${servicio}`).not.toBeNull();
      expect(tablas, `${base}: la tabla ${control} no está en el esquema de ${servicio}`).toContain(
        control,
      );
    }
  });

  it('la base de eventos se comprueba contra el esquema de la cola', () => {
    // No es una tabla del dominio: es la tabla de trabajos de `pg-boss`, que tiene que
    // existir aunque el resto de la base esté vacía.
    expect(TABLA_DE_CONTROL['odonto_events']).toBe('pgboss.job');
  });

  it('el prefijo de las bases es el del sistema', () => {
    for (const base of Object.keys(TABLA_DE_CONTROL)) {
      expect(base.startsWith('odonto_')).toBe(true);
    }
  });
});
