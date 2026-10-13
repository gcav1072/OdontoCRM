import { describe, expect, it } from 'vitest';

import {
  carpetaManualDeRespaldos,
  conservarRespaldosManuales,
  formatearRespaldoCompleto,
  marcaDeTiempo,
  nombreAlmacenDeRespaldo,
  nombreConfigDeRespaldo,
  podarRespaldoManual,
} from './admin-informes.mjs';

/**
 * Las **piezas puras** del respaldo completo (`/respaldo` del bot de administración): los
 * nombres de los archivos, la marca de tiempo, la retención y el texto del resumen. Son las que
 * tienen que seguir siendo correctas sin pila ni base de datos, y las que se rompen en silencio
 * (un nombre distinto = `odontocrm recuperar` no encuentra el almacén; una poda mal hecha = se
 * borra la copia que acaba de hacerse).
 */
describe('nombres de los archivos del respaldo completo', () => {
  /**
   * No son decorativos: son los que **espera la restauración** de cada plataforma. Si cambian,
   * `odontocrm recuperar --from DIR` extrae el almacén en el sitio equivocado o no lo encuentra.
   */
  it('cada plataforma usa los nombres de su respaldo nocturno', () => {
    expect(nombreAlmacenDeRespaldo('win32')).toBe('storage.zip');
    expect(nombreConfigDeRespaldo('win32')).toBe('config.zip');

    expect(nombreAlmacenDeRespaldo('linux', '2026-10-12_033001')).toBe(
      'storage_2026-10-12_033001.tar.gz',
    );
    expect(nombreConfigDeRespaldo('linux', '2026-10-12_033001')).toBe(
      'etc-odontocrm_2026-10-12_033001.tar.gz',
    );
  });
});

describe('marca de tiempo de las copias', () => {
  /**
   * `AAAA-MM-DD_HHMMSS`, la misma forma que la del respaldo nocturno. Que sea ordenable
   * alfabéticamente es lo que hace que la retención pueda ser un `sort()`.
   */
  it('tiene la forma del respaldo nocturno y ordena como ordena el calendario', () => {
    // Mes 9 = octubre (los meses de `Date` van de 0 a 11).
    expect(marcaDeTiempo(new Date(2026, 9, 12, 3, 30, 1))).toBe('2026-10-12_033001');
    expect(marcaDeTiempo(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05_000000');

    const enero = marcaDeTiempo(new Date(2026, 0, 31, 23, 59, 59));
    const febrero = marcaDeTiempo(new Date(2026, 1, 1, 0, 0, 0));
    expect(enero < febrero).toBe(true);
  });
});

describe('retención de los respaldos manuales', () => {
  /**
   * Cada copia lleva el almacén entero dentro, así que no caben treinta como en la carpeta del
   * temporizador: se conservan las más nuevas y se borran las demás.
   */
  it('borra las más viejas y conserva las N más nuevas', () => {
    const nombres = ['2026-10-01_030000', '2026-10-03_030000', '2026-10-02_030000'];

    expect(podarRespaldoManual(nombres, 2)).toEqual(['2026-10-01_030000']);
    expect(podarRespaldoManual(nombres, 3)).toEqual([]);
    expect(podarRespaldoManual(nombres, 5)).toEqual([]);
    // `sort()` ordena el original: no puede reordenar la lista de quien la pasa.
    expect(nombres[0]).toBe('2026-10-01_030000');
  });

  it('el número se puede cambiar por entorno, con 5 de fábrica', () => {
    const antes = process.env.ODONTOCRM_BACKUP_MANUAL_KEEP;
    try {
      delete process.env.ODONTOCRM_BACKUP_MANUAL_KEEP;
      expect(conservarRespaldosManuales()).toBe(5);

      process.env.ODONTOCRM_BACKUP_MANUAL_KEEP = '3';
      expect(conservarRespaldosManuales()).toBe(3);

      // Un valor que no sirve no puede dejar la carpeta sin podar ni tumbarlo todo.
      process.env.ODONTOCRM_BACKUP_MANUAL_KEEP = 'ninguna';
      expect(conservarRespaldosManuales()).toBe(5);
    } finally {
      if (antes === undefined) delete process.env.ODONTOCRM_BACKUP_MANUAL_KEEP;
      else process.env.ODONTOCRM_BACKUP_MANUAL_KEEP = antes;
    }
  });
});

describe('dónde se guardan las copias', () => {
  it('la variable de entorno manda sobre la carpeta por defecto', () => {
    const antes = process.env.ODONTOCRM_BACKUP_MANUAL_DIR;
    try {
      process.env.ODONTOCRM_BACKUP_MANUAL_DIR = '/media/pendrive/respaldos';
      expect(carpetaManualDeRespaldos()).toBe('/media/pendrive/respaldos');

      // Vacía no cuenta como «dicha»: se cae a la del sistema.
      process.env.ODONTOCRM_BACKUP_MANUAL_DIR = '   ';
      expect(carpetaManualDeRespaldos()).not.toBe('   ');
    } finally {
      if (antes === undefined) delete process.env.ODONTOCRM_BACKUP_MANUAL_DIR;
      else process.env.ODONTOCRM_BACKUP_MANUAL_DIR = antes;
    }
  });
});

describe('resumen del respaldo completo', () => {
  const archivo = (base, bytes) => ({
    base,
    bytes,
    nombre: `${base}.dump`,
    sha256: 'a'.repeat(64),
  });

  const resultadoBase = {
    dir: 'D:\\OdontoCRM\\data\\respaldo-manual\\2026-10-12_033001',
    archivos: [archivo('odonto_patients', 1_048_576), archivo('odonto_events', 2048)],
    extras: [
      { etiqueta: 'almacenamiento', nombre: 'storage.zip', bytes: 20 * 1024 * 1024 },
      { etiqueta: 'configuración (CON SECRETOS)', nombre: 'config.zip', bytes: 4096 },
    ],
    fallos: [],
    sinCredenciales: [],
    avisos: [],
    podadas: [],
    bytes: 1_048_576 + 2048 + 20 * 1024 * 1024 + 4096,
    bytesBases: 1_048_576 + 2048,
  };

  it('dice dónde quedó, qué trae y cómo comprobarla y reponerla', () => {
    const texto = formatearRespaldoCompleto(resultadoBase);

    expect(texto).toContain(resultadoBase.dir);
    expect(texto).toContain('odonto_patients');
    expect(texto).toContain('1 MB');
    expect(texto).toContain('almacenamiento');
    // El aviso de los secretos no es opcional: la configuración los lleva dentro.
    expect(texto).toContain('SECRETOS');
    expect(texto).toContain('verify:backup');
    expect(texto).toContain('odontocrm recuperar');
  });

  it('avisa de lo que faltó, porque una copia incompleta no sirve', () => {
    const texto = formatearRespaldoCompleto({
      ...resultadoBase,
      fallos: [{ base: 'odonto_billing', motivo: 'pg_dump falló: FATAL' }],
      sinCredenciales: ['patients'],
      avisos: ['no existe el almacén /var/lib/odontocrm/storage: la copia va sin radiografías'],
      podadas: ['2026-09-01_030000', '2026-09-02_030000'],
    });

    expect(texto).toContain('odonto_billing');
    expect(texto).toContain('FATAL');
    expect(texto).toContain('sin DATABASE_URL: patients');
    expect(texto).toContain('no existe el almacén');
    expect(texto).toContain('retención: borradas 2 copia(s)');
  });

  it('cabe en un mensaje de Telegram', () => {
    // 4096 caracteres es el tope de Telegram: con las nueve bases y los tres bloques, entra.
    const muchas = Array.from({ length: 9 }, (_, indice) =>
      archivo(`odonto_servicio_${String(indice)}`, 1024),
    );
    const texto = formatearRespaldoCompleto({ ...resultadoBase, archivos: muchas });
    expect(texto.length).toBeLessThan(4096);
  });
});
