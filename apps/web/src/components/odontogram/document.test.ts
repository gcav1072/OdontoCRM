import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  OdontogramDetail,
  ToothFindingHistoryEntry,
  ToothFindingRecord,
} from '@odontocrm/contracts';

import { OdontogramDocument } from './OdontogramDocument';
import { TOOTH_LABEL_BASELINE } from './GeometricTooth';

/**
 * Pruebas de pintado de la vista impresa. Se renderiza a HTML real (servidor) en
 * vez de montar el DOM: lo que hay que comprobar es el **documento**, que la
 * secretaría imprime tal cual, así que importa que aparezcan el paciente, las
 * piezas, las caras afectadas con su color y el estado de cada hallazgo.
 *
 * El archivo va en `.ts` y no en `.tsx` porque `vitest.config.ts` solo recoge
 * `**\/*.test.ts`: el JSX se escribe con `createElement` para no quedar fuera de la
 * suite (el componente en sí sigue siendo `.tsx`).
 */

const hallazgo = (parcial: Partial<ToothFindingRecord>): ToothFindingRecord => ({
  id: `00000000-0000-4000-8000-0000000000${String(parcial.toothNumber ?? 10).slice(-2)}`,
  toothNumber: 16,
  surface: 'occlusal',
  condition: 'caries',
  state: 'pendiente',
  notes: null,
  recordedByUsername: 'prueba',
  recordedAt: '2026-10-05T14:00:00.000Z',
  updatedAt: '2026-10-05T14:00:00.000Z',
  sessionId: null,
  resolvedAt: null,
  ...parcial,
});

const detalle = (
  findings: Record<string, ToothFindingRecord[]>,
  dentition: OdontogramDetail['dentition'] = 'permanente',
): OdontogramDetail => ({
  id: '11111111-1111-4111-8111-111111111111',
  patientId: '22222222-2222-4222-8222-222222222222',
  dentition,
  findings,
  prostheses: [],
  affectedTeeth: Object.keys(findings).map(Number),
  empty: Object.keys(findings).length === 0,
  recordedByUsername: 'prueba',
  recordedAt: '2026-10-05T13:00:00.000Z',
  updatedAt: '2026-10-05T14:00:00.000Z',
  lastPrintedAt: null,
  printCount: 2,
  patient: {
    id: '22222222-2222-4222-8222-222222222222',
    fullName: 'María Pérez',
    document: 'V-12345678',
    birthDate: '1988-04-12',
    age: 38,
    sex: 'F',
    phone: null,
    address: null,
    occupation: null,
  },
});

const documento = (detail: OdontogramDetail): string =>
  renderToStaticMarkup(createElement(OdontogramDocument, { detail }));

/** Entrada del histórico, para el informe que se pide «con historial». */
const cambio = (parcial: Partial<ToothFindingHistoryEntry>): ToothFindingHistoryEntry => ({
  id: `hist-${String(parcial.occurredAt ?? 'x')}-${String(parcial.event ?? 'registrado')}`,
  toothNumber: 16,
  surface: 'occlusal',
  condition: 'caries',
  state: 'pendiente',
  event: 'registrado',
  reason: null,
  notes: null,
  actorUsername: 'prueba',
  occurredAt: '2026-10-01T09:00:00.000Z',
  ...parcial,
});

const conHistorial = (
  cambios: readonly ToothFindingHistoryEntry[],
  historyLimit?: number,
): string =>
  renderToStaticMarkup(
    createElement(OdontogramDocument, {
      detail: detalle({ '16': [hallazgo({ toothNumber: 16 })] }),
      history: cambios,
      ...(historyLimit === undefined ? {} : { historyLimit }),
    }),
  );

describe('documento imprimible del odontograma', () => {
  it('pinta al paciente, las piezas con su número y el color de cada estado', () => {
    const html = documento(
      detalle({
        '16': [
          hallazgo({ toothNumber: 16, surface: 'occlusal', state: 'pendiente' }),
          hallazgo({
            toothNumber: 16,
            surface: 'mesial',
            condition: 'restauracion',
            state: 'completado',
          }),
        ],
        '48': [hallazgo({ toothNumber: 48, surface: null, condition: 'ausente' })],
      }),
    );

    expect(html).toContain('María Pérez');
    expect(html).toContain('V-12345678');

    // Las piezas de la dentición permanente están todas, con su número visible.
    for (const pieza of [18, 11, 21, 28, 48, 41, 31, 38]) {
      expect(html).toContain(`>${String(pieza)}</text>`);
    }

    // Los colores del doc §7.2 (rojo pendiente, azul completado) y el símbolo de ausente.
    expect(html).toContain('#ef4444');
    expect(html).toContain('#3b82f6');
    expect(html).toContain('Odontograma');
  });

  it('pinta el membrete con el logo del repositorio (sin inventar datos del consultorio)', () => {
    const html = documento(detalle({ '16': [hallazgo({ toothNumber: 16 })] }));
    // La identidad del consultorio la sirve el registro del titular. Sin ella, el respaldo
    // `CLINIC` es neutro (sin datos personales): no se imprime ningún nombre ni dirección.
    // El logo sí sale: es el del repositorio (`BRAND.logoPath`), resuelto por Vite.
    expect(html).toContain('h-[var(--brand-logo-height-mm)]');
    // Sin identidad no se inventa ningún dato del consultorio (ni siquiera el RIF).
    expect(html).not.toContain('RIF ');
  });

  it('sin hallazgos lo dice en vez de fingir una boca explorada', () => {
    expect(documento(detalle({}))).toContain('Todavía no hay hallazgos');
  });

  it('la pieza ausente y la corona se explican en el pie; el conducto no tapa nada', () => {
    const ausente = documento(
      detalle({ '36': [hallazgo({ toothNumber: 36, surface: null, condition: 'ausente' })] }),
    );
    expect(ausente).toContain('Ausente');
    expect(ausente).toContain('quedan sin efecto');
    // De la corona no se avisa aquí: no hay ninguna.
    expect(ausente).not.toContain('cubiertas por la corona');

    // Corona y restauración en la misma pieza: las dos salen en la tabla, y el pie
    // explica que la corona **recubre** el muñón (ADR 0032).
    const tratada = documento(
      detalle({
        '36': [
          hallazgo({ toothNumber: 36, surface: null, condition: 'corona', state: 'completado' }),
          hallazgo({
            toothNumber: 36,
            surface: 'occlusal',
            condition: 'restauracion',
            state: 'completado',
          }),
        ],
      }),
    );
    expect(tratada).toContain('Corona');
    expect(tratada).toContain('Restauración');
    expect(tratada).toContain('cubiertas por la corona');
    expect(tratada).not.toContain('quedan sin efecto');

    // El conducto no recubre nada: no se avisa de nada.
    const conducto = documento(
      detalle({
        '36': [
          hallazgo({ toothNumber: 36, surface: null, condition: 'endodoncia' }),
          hallazgo({ toothNumber: 36, surface: 'occlusal', condition: 'caries' }),
        ],
      }),
    );
    expect(conducto).not.toContain('quedan sin efecto');
    expect(conducto).not.toContain('cubiertas por la corona');
  });
});

describe('el informe impreso se lee como un documento clínico', () => {
  it('ordena los hallazgos por número de pieza, no por orden de captura', () => {
    // Se registran desordenados a propósito, como los añade la consulta.
    const boca = documento(
      detalle({
        '48': [hallazgo({ toothNumber: 48, surface: 'vestibular' })],
        '13': [hallazgo({ toothNumber: 13, surface: 'vestibular' })],
        '42': [hallazgo({ toothNumber: 42, surface: null, condition: 'implante' })],
        '25': [hallazgo({ toothNumber: 25, surface: 'occlusal' })],
        '36': [hallazgo({ toothNumber: 36, surface: 'lingual' })],
        '33': [hallazgo({ toothNumber: 33, surface: 'occlusal' })],
        '44': [
          hallazgo({ toothNumber: 44, surface: null, condition: 'corona', state: 'completado' }),
        ],
      }),
    );

    // En la tabla, la primera columna de cada fila es la pieza: se leen en orden.
    const filas = [...boca.matchAll(/<tr class="border-b[^"]*"><td[^>]*>(\d+)<\/td>/g)].map(
      (coincidencia) => Number(coincidencia[1]),
    );
    expect(filas).toEqual([13, 25, 33, 36, 42, 44, 48]);
  });

  it('una celda de notas vacía dice «Sin observaciones», no se queda en blanco', () => {
    const boca = documento(
      detalle({
        '16': [hallazgo({ toothNumber: 16, notes: null })],
        '17': [hallazgo({ toothNumber: 17, notes: '   ' })],
        '18': [hallazgo({ toothNumber: 18, notes: 'Sellado preventivo en 2024' })],
      }),
    );

    expect(boca).toContain('Sin observaciones');
    // Y la nota de verdad sigue saliendo tal cual.
    expect(boca).toContain('Sellado preventivo en 2024');
    // Dos de las tres filas no llevan nota: las dos lo dicen.
    expect([...boca.matchAll(/Sin observaciones/g)]).toHaveLength(2);
  });

  it('la leyenda enseña cada tratamiento en los colores que admite (indicado y realizado)', () => {
    const boca = documento(detalle({}));

    // Rojo = indicado/pendiente: los cuatro tratamientos se pueden indicar.
    // Azul = realizado: la extracción indicada **no** —cuando se hace, la pieza queda
    // ausente, no «extracción completada» (spec §2)—, así que solo corona, implante y
    // conducto llevan el azul.
    const enRojo = [...boca.matchAll(/stroke="#ef4444"/g)].length;
    const enAzul = [...boca.matchAll(/stroke="#3b82f6"/g)].length;
    expect(enRojo).toBeGreaterThanOrEqual(4);
    expect(enAzul).toBeGreaterThanOrEqual(3);

    // Y el texto lo explica, que es lo que pidió el odontólogo.
    expect(boca).toContain('rojo indicado · azul realizado');
    expect(boca).toContain('Azul: tratamiento ya realizado');
    expect(boca).toContain('Rojo: caries, restauración o tratamiento indicado');
  });
});

describe('el documento se lee como la boca del paciente', () => {
  /**
   * Reparto de cada pieza en el marcado: la clave es el número que lleva debajo, y
   * dentro va lo que se le ha dibujado. Se parte por la apertura de cada grupo de
   * pieza —`translate(N,0)`, con el `,0` exacto que no tiene ningún otro grupo— para
   * poder afirmar **en qué casilla** cayó cada hallazgo.
   */
  const casillas = (markup: string): Map<number, string> => {
    const trozos = markup.split(/<g transform="translate\((\d+),0\)">/).slice(1);
    const mapa = new Map<number, string>();
    for (let i = 0; i < trozos.length; i += 2) {
      const x = Number(trozos[i]);
      const cuerpo = trozos[i + 1] ?? '';
      const etiqueta = />(\d{2})<\/text>/.exec(cuerpo)?.[1];
      if (etiqueta === undefined) continue;
      mapa.set(Number(etiqueta), `${String(x)}|${cuerpo}`);
    }
    return mapa;
  };

  it('cada hallazgo cae en la casilla de su número de pieza (implante en la 42, corona en la 44)', () => {
    const html = documento(
      detalle({
        '42': [hallazgo({ toothNumber: 42, surface: null, condition: 'implante' })],
        '44': [
          hallazgo({ toothNumber: 44, surface: null, condition: 'corona', state: 'completado' }),
        ],
        '36': [hallazgo({ toothNumber: 36, surface: 'lingual', condition: 'caries' })],
      }),
    );
    const mapa = casillas(html);

    expect(mapa.get(42)).toContain('data-condicion="implante"');
    expect(mapa.get(44)).toContain('data-condicion="corona"');
    // Y no en la de al lado: es el fallo que había que descartar.
    expect(mapa.get(42)).not.toContain('data-condicion="corona"');
    expect(mapa.get(44)).not.toContain('data-condicion="implante"');
    expect(mapa.get(41)).not.toContain('data-condicion');

    // La cara lingual de la 36 en la mandíbula es el trapecio **de arriba**
    // (el volteo pone la vestibular abajo): `lingual` = `100,100 0,100 25,75 75,75`.
    expect(mapa.get(36)).toContain('points="100,100 0,100 25,75 75,75"');
  });

  it('en el papel el número también queda separado del cuadro', () => {
    const boca = documento(detalle({}));
    expect(boca).toContain(`y="${String(TOOTH_LABEL_BASELINE)}"`);

    // Las dos arcadas (maxilar y mandíbula) reservan alto de sobra para el número.
    // Se buscan por su `class="w-full"` para no confundirlas con los símbolos de la
    // leyenda, que también son `svg` con `viewBox`.
    const altos = [...boca.matchAll(/viewBox="0 0 [\d.]+ ([\d.]+)" class="w-full"/g)].map((match) =>
      Number(match[1]),
    );
    expect(altos).toHaveLength(2);
    for (const alto of altos) {
      expect(alto).toBeGreaterThanOrEqual(TOOTH_LABEL_BASELINE + 8);
    }
  });

  it('los números de la arcada inferior no se espejan', () => {
    const boca = documento(detalle({}));
    // Un `scale(1,-1)` sobre el `<text>` devolvía el número a su sitio pero
    // invertía los dígitos (el 48 se leía «8t»).
    expect(/<text[^>]*transform=/.test(boca)).toBe(false);
    // Y los dos números de la línea media se leen tal cual.
    expect(boca).toContain('>41</text>');
    expect(boca).toContain('>31</text>');
  });

  it('la línea media separa los cuadrantes y cada arcada dice su orientación', () => {
    const boca = documento(detalle({}));
    const mapa = casillas(boca);
    const x = (pieza: number): number => Number((mapa.get(pieza) ?? '0|').split('|')[0]);

    // Hueco extra entre el 11 y el 21, y entre el 41 y el 31.
    expect(x(21) - x(11)).toBeGreaterThan(x(11) - x(12));
    expect(x(31) - x(41)).toBeGreaterThan(x(41) - x(42));

    // Y el papel explica hacia dónde mira cada cara.
    expect(boca).toContain('vestibular arriba');
    expect(boca).toContain('lingual arriba');
  });
});

describe('el historial de cambios en el informe (casilla de la impresión)', () => {
  it('sin pedirlo, el informe no lleva historial', () => {
    const boca = documento(detalle({ '16': [hallazgo({ toothNumber: 16 })] }));
    expect(boca).not.toContain('Historial de cambios');
  });

  it('con la casilla, sale en orden cronológico con fechas, quién y qué cambió', () => {
    const html = conHistorial([
      // Llegan del más nuevo al más viejo, como los sirve la pantalla.
      cambio({
        occurredAt: '2026-10-04T10:00:00.000Z',
        event: 'superado',
        condition: 'restauracion',
        reason: 'superado por «corona»',
      }),
      cambio({ occurredAt: '2026-10-01T09:00:00.000Z', event: 'registrado' }),
    ]);

    expect(html).toContain('Historial de cambios del odontograma');
    expect(html).toContain('del más antiguo al más reciente');
    // En el papel, el primero es el más viejo: es una evolución, no una bandeja.
    expect(html.indexOf('Registrado')).toBeLessThan(html.indexOf('Superado'));
    // Con su actor y su motivo, que es lo que da valor probatorio al documento.
    expect(html).toContain('prueba');
    expect(html).toContain('superado por «corona»');
    expect(html).toContain('Oclusal');
  });

  it('la 33 se nombra con borde incisal también en el historial', () => {
    const html = conHistorial([cambio({ toothNumber: 33, surface: 'occlusal' })]);
    expect(html).toContain('Incisal');
  });

  it('si el historial llegó al tope, el informe lo dice', () => {
    const dos = [
      cambio({ occurredAt: '2026-10-01T09:00:00.000Z' }),
      cambio({ occurredAt: '2026-10-02T09:00:00.000Z', event: 'actualizado' }),
    ];
    expect(conHistorial(dos, 2)).toContain('se muestran los 2 más recientes');
    // Si no se llegó al tope, no hay nada que avisar.
    expect(conHistorial(dos, 500)).not.toContain('se muestran los');
  });
});

describe('la banda de piezas temporales solo sale si hay cambios en ellas', () => {
  const CAPTION = 'Arcada superior · temporal';

  it('en una boca permanente no se dibuja la banda temporal', () => {
    const boca = documento(detalle({ '16': [hallazgo({ toothNumber: 16 })] }));
    expect(boca).not.toContain(CAPTION);
  });

  it('una boca mixta sin hallazgos en piezas de leche no imprime la banda temporal', () => {
    // Puede pasar al corregir la captura: quedan permanentes y una temporal superada.
    const boca = documento(detalle({ '16': [hallazgo({ toothNumber: 16 })] }, 'mixta'));
    expect(boca).not.toContain(CAPTION);
    // La arcada permanente sí está: el informe no se queda sin diagrama.
    expect(boca).toContain('Maxilar · vestibular arriba');
  });

  it('un hallazgo en una pieza de leche hace salir la banda temporal', () => {
    const boca = documento(
      detalle(
        {
          '16': [hallazgo({ toothNumber: 16 })],
          '55': [hallazgo({ toothNumber: 55, surface: 'occlusal', condition: 'caries' })],
        },
        'mixta',
      ),
    );
    expect(boca).toContain(CAPTION);
    expect(boca).toContain('Arcada inferior · temporal');
    // Y la pieza de leche con su número, en su banda.
    expect(boca).toContain('>55</text>');
  });
});
