import { describe, expect, it } from 'vitest';

import {
  carpetaManualDeRespaldos,
  conservarRespaldosManuales,
  formatearActivacionLicencia,
  formatearLicenciaDetalle,
  formatearLicenciaParaEstado,
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

describe('licencia en el estado (ADR 0075)', () => {
  /** Vista pública tal como la devuelve `GET /api/v1/licensing/public`. */
  const vistaPublica = (extra = {}) => ({
    estado: 'trial',
    soloLectura: false,
    origen: 'trial',
    tipo: null,
    diasRestantes: 23,
    venceEn: '2026-12-11T13:00:00.000Z',
    mensaje: 'Estás en el periodo de prueba: quedan 23 días.',
    ...extra,
  });

  it('resume la prueba y la licencia en una línea, para el tablero y el bot', () => {
    expect(formatearLicenciaParaEstado(vistaPublica())).toBe(
      'prueba hasta el 11/12/2026 · quedan 23 días',
    );

    expect(
      formatearLicenciaParaEstado(
        vistaPublica({
          estado: 'licencia_vigente',
          origen: 'licencia',
          tipo: 'mensual',
          diasRestantes: 30,
        }),
      ),
    ).toBe('licencia mensual vigente hasta el 11/12/2026 · quedan 30 días');
  });

  it('avisa cuando la prueba o la licencia están por vencer', () => {
    const prueba = formatearLicenciaParaEstado(
      vistaPublica({ estado: 'trial_por_vencer', diasRestantes: 5 }),
    );
    expect(prueba).toContain('por vencer');
    expect(prueba).toContain('quedan 5 días');

    const licencia = formatearLicenciaParaEstado(
      vistaPublica({
        estado: 'licencia_por_vencer',
        origen: 'licencia',
        tipo: 'anual',
        diasRestantes: 3,
      }),
    );
    expect(licencia).toContain('licencia anual');
    expect(licencia).toContain('quedan 3 días');
  });

  it('grita el modo consulta y el reloj atrasado', () => {
    for (const estado of ['trial_vencida', 'licencia_vencida']) {
      const texto = formatearLicenciaParaEstado(
        vistaPublica({ estado, soloLectura: true, diasRestantes: 0 }),
      );
      expect(texto).toContain('MODO CONSULTA');
      // El modo consulta no es «no se puede usar»: se puede ver, imprimir y exportar.
      expect(texto).toContain('imprimir');
    }

    expect(
      formatearLicenciaParaEstado(vistaPublica({ estado: 'reloj_atrasado', soloLectura: true })),
    ).toContain('reloj del equipo atrasado');
  });

  it('una vitalicia se resume sin vencimiento y sin «quedan días»', () => {
    const texto = formatearLicenciaParaEstado(
      vistaPublica({
        estado: 'licencia_vigente',
        origen: 'licencia',
        tipo: 'vitalicia',
        diasRestantes: null,
        venceEn: null,
        mensaje: 'Licencia vitalicia: no vence y no hay que renovarla.',
      }),
    );

    expect(texto).toBe('licencia vitalicia vigente · sin vencimiento');
  });

  it('una licencia no comprobable se dice, no se inventa', () => {
    expect(formatearLicenciaParaEstado({ error: 'HTTP 404' })).toBe('no comprobable (HTTP 404)');
    // Una foto vieja del tablero no trae el campo: mejor no pintar nada que mentir.
    expect(formatearLicenciaParaEstado(undefined)).toBeNull();
  });
});

describe('detalle de la licencia para el bot', () => {
  /** Vista del administrador tal como la devuelve la ruta interna de identity. */
  const vistaInterna = (extra = {}) => ({
    estado: 'trial_por_vencer',
    soloLectura: false,
    origen: 'trial',
    tipo: null,
    diasRestantes: 5,
    venceEn: '2026-12-11T13:00:00.000Z',
    mensaje: 'La prueba vence en 5 días (el 11/12/2026). Solicita la licencia.',
    instalacion: '8e6b6e4c-1111-4222-8333-444455556666',
    instaladaEn: '2026-10-12T13:00:00.000Z',
    ultimaVezVisto: '2026-11-11T13:00:00.000Z',
    licencia: null,
    consultorio: { nombre: 'Consultorio Sonrisa', rif: 'J-12345678-9' },
    solicitud: {
      codigo: 'ODO-REQ1.abc',
      texto:
        'OdontoCRM · solicitud de licencia\nConsultorio: Consultorio Sonrisa\nCódigo: ODO-REQ1.abc',
    },
    ...extra,
  });

  it('trae la instalación, la solicitud y las instrucciones de activación', () => {
    const texto = formatearLicenciaDetalle(vistaInterna());

    expect(texto).toContain('Estado:');
    expect(texto).toContain('Instalación: 8e6b6e4c-1111-4222-8333-444455556666');
    expect(texto).toContain('Consultorio Sonrisa');
    expect(texto).toContain('J-12345678-9');
    expect(texto).toContain('ODO-REQ1.abc');
    expect(texto).toContain('reenvía');
    expect(texto).toContain('.lic');
  });

  it('con la vista pública (sin secreto interno) dice qué falta, en vez de enseñar huecos', () => {
    const texto = formatearLicenciaDetalle(
      vistaInterna({ instalacion: undefined, consultorio: undefined, solicitud: undefined }),
    );

    expect(texto).toContain('INTERNAL_SERVICE_SECRET');
    expect(texto).toContain('Estado:');
  });

  it('un error de lectura se cuenta sin romper el bot', () => {
    expect(formatearLicenciaDetalle({ error: 'ECONNREFUSED' })).toContain('ECONNREFUSED');
    expect(formatearLicenciaDetalle(undefined)).toContain('no pude leer');
  });

  it('el detalle y la activación de una vitalicia dicen «sin vencimiento»', () => {
    const vitalicia = vistaInterna({
      estado: 'licencia_vigente',
      origen: 'licencia',
      tipo: 'vitalicia',
      diasRestantes: null,
      venceEn: null,
      mensaje: 'Licencia vitalicia: no vence y no hay que renovarla.',
      licencia: {
        id: 'LIC-2026-0009',
        tipo: 'vitalicia',
        cliente: { nombre: 'Consultorio Sonrisa' },
        emitidaEn: '2026-11-11T13:00:00.000Z',
        venceEn: null,
        activadaEn: '2026-11-11T13:05:00.000Z',
      },
    });

    expect(formatearLicenciaDetalle(vitalicia)).toContain('Vigencia: sin vencimiento (vitalicia)');
    const activacion = formatearActivacionLicencia(vitalicia);
    expect(activacion).toContain('vitalicia');
    expect(activacion).toContain('Sin vencimiento (vitalicia).');
    expect(activacion).not.toContain('Quedan');
  });

  it('la activación correcta se responde con el tipo y el vencimiento', () => {
    const texto = formatearActivacionLicencia({
      estado: 'licencia_vigente',
      soloLectura: false,
      origen: 'licencia',
      tipo: 'mensual',
      diasRestantes: 30,
      venceEn: '2026-12-11T13:00:00.000Z',
      mensaje: 'Licencia mensual vigente hasta el 11/12/2026.',
    });

    expect(texto).toContain('✔ Licencia activada');
    expect(texto).toContain('mensual');
    expect(texto).toContain('11/12/2026');
    expect(texto).toContain('30 días');
    expect(texto.length).toBeLessThan(4096);
  });
});
