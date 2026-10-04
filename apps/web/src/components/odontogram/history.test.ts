import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ToothFindingHistoryEntry } from '@odontocrm/contracts';

import {
  OdontogramHistory,
  filterEntries,
  groupByDay,
  groupHistory,
  historyDayKey,
  historyEventLabel,
  parseToothFilter,
  sortHistoryDesc,
  type HistorySessionResolver,
} from './OdontogramHistory';

/**
 * Pruebas de la parte pura de la evolución del odontograma: agrupación por día,
 * filtros y lectura del campo de pieza. El componente solo pinta lo que devuelven
 * estas funciones, así que aquí es donde se fija el comportamiento.
 *
 * Las horas de las entradas son UTC a propósito: la zona del consultorio
 * (`America/Caracas`, UTC−4) es la que decide el día, no la del equipo donde corran
 * las pruebas.
 */

const entrada = (cambios: Partial<ToothFindingHistoryEntry> = {}): ToothFindingHistoryEntry => ({
  id: 'hist-1',
  toothNumber: 16,
  surface: null,
  condition: 'corona',
  state: 'pendiente',
  event: 'registrado',
  reason: null,
  notes: null,
  actorUsername: 'ana',
  occurredAt: '2026-10-02T13:30:00.000Z',
  ...cambios,
});

describe('historyDayKey', () => {
  it('usa el día del consultorio y no el de la máquina', () => {
    // 9:30 a. m. en Caracas: mismo día UTC y mismo día local.
    expect(historyDayKey('2026-10-02T13:30:00.000Z')).toBe('2026-10-02');

    // 10:30 p. m. del 1 de octubre en Caracas, ya 2 de octubre en UTC: el cambio
    // pertenece al día 1 y agruparlo por el ISO lo mandaría al día siguiente.
    expect(historyDayKey('2026-10-02T02:30:00.000Z')).toBe('2026-10-01');
  });

  it('devuelve una clave vacía si la fecha no es legible', () => {
    expect(historyDayKey('no-es-una-fecha')).toBe('');
    expect(historyDayKey(null)).toBe('');
  });
});

describe('groupByDay', () => {
  it('agrupa por día, del más reciente al más antiguo y sin mutar la entrada', () => {
    const entradas = [
      entrada({ id: 'a', occurredAt: '2026-10-01T14:00:00.000Z' }),
      entrada({ id: 'b', occurredAt: '2026-10-03T14:00:00.000Z', toothNumber: 26 }),
      entrada({ id: 'c', occurredAt: '2026-10-01T18:00:00.000Z', toothNumber: 36 }),
      entrada({ id: 'd', occurredAt: '2026-10-02T14:00:00.000Z', toothNumber: 46 }),
    ];
    const copia = [...entradas];

    const grupos = groupByDay(entradas);

    expect(grupos.map((grupo) => grupo.key)).toEqual(['2026-10-03', '2026-10-02', '2026-10-01']);
    // Dentro del día, la hora también va de la más reciente a la más antigua.
    expect(grupos[2]?.entries.map((item) => item.id)).toEqual(['c', 'a']);
    expect(grupos[0]?.occurredAt).toBe('2026-10-03T14:00:00.000Z');
    expect(entradas).toEqual(copia);
  });

  it('no mezcla días distintos aunque la hora sea casi la misma', () => {
    const grupos = groupByDay([
      // 11:00 p. m. del 1 de octubre en Caracas.
      entrada({ id: 'tarde', occurredAt: '2026-10-02T03:00:00.000Z' }),
      // 1:00 a. m. del 2 de octubre en Caracas.
      entrada({ id: 'temprano', occurredAt: '2026-10-02T05:00:00.000Z' }),
    ]);

    expect(grupos).toHaveLength(2);
    expect(grupos[0]?.key).toBe('2026-10-02');
    expect(grupos[1]?.key).toBe('2026-10-01');
  });

  it('conserva las entradas sin notas ni motivo (la fila no pinta esos bloques)', () => {
    const grupos = groupByDay([entrada({ notes: null, reason: null })]);

    expect(grupos).toHaveLength(1);
    expect(grupos[0]?.entries).toHaveLength(1);
    expect(grupos[0]?.entries[0]?.notes).toBeNull();
    expect(grupos[0]?.entries[0]?.reason).toBeNull();
    expect(grupos[0]?.session).toBeNull();
  });

  it('devuelve una lista vacía sin entradas', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('sortHistoryDesc', () => {
  it('ordena de lo más reciente a lo más antiguo sin tocar el arreglo original', () => {
    const entradas = [
      entrada({ id: 'vieja', occurredAt: '2026-09-01T12:00:00.000Z' }),
      entrada({ id: 'nueva', occurredAt: '2026-10-05T12:00:00.000Z' }),
    ];

    expect(sortHistoryDesc(entradas).map((item) => item.id)).toEqual(['nueva', 'vieja']);
    expect(entradas.map((item) => item.id)).toEqual(['vieja', 'nueva']);
  });
});

describe('filterEntries', () => {
  const entradas = [
    entrada({ id: 'carles-16', toothNumber: 16, event: 'registrado', condition: 'caries' }),
    entrada({ id: 'corona-16', toothNumber: 16, event: 'actualizado', condition: 'corona' }),
    entrada({ id: 'carles-26', toothNumber: 26, event: 'registrado', condition: 'caries' }),
    entrada({ id: 'superado-26', toothNumber: 26, event: 'superado', condition: 'caries' }),
  ];

  it('sin filtros devuelve todo, en el mismo orden', () => {
    expect(filterEntries(entradas, {}).map((item) => item.id)).toEqual([
      'carles-16',
      'corona-16',
      'carles-26',
      'superado-26',
    ]);
    expect(filterEntries(entradas, { toothNumber: null, event: null })).toHaveLength(4);
  });

  it('filtra por pieza FDI', () => {
    expect(filterEntries(entradas, { toothNumber: 26 }).map((item) => item.id)).toEqual([
      'carles-26',
      'superado-26',
    ]);
    expect(filterEntries(entradas, { toothNumber: 85 })).toEqual([]);
  });

  it('filtra por tipo de cambio', () => {
    expect(filterEntries(entradas, { event: 'registrado' }).map((item) => item.id)).toEqual([
      'carles-16',
      'carles-26',
    ]);
    expect(filterEntries(entradas, { event: 'eliminado' })).toEqual([]);
  });

  it('combina pieza y tipo de cambio', () => {
    expect(
      filterEntries(entradas, { toothNumber: 16, event: 'actualizado' }).map((item) => item.id),
    ).toEqual(['corona-16']);
    expect(filterEntries(entradas, { toothNumber: 16, event: 'superado' })).toEqual([]);
  });
});

describe('parseToothFilter', () => {
  it('acepta las piezas permanentes (11–48) y las temporales (51–85)', () => {
    expect(parseToothFilter('16')).toEqual({ value: 16, invalid: false });
    expect(parseToothFilter('48')).toEqual({ value: 48, invalid: false });
    expect(parseToothFilter('51')).toEqual({ value: 51, invalid: false });
    expect(parseToothFilter('85')).toEqual({ value: 85, invalid: false });
  });

  it('no filtra ni avisa mientras el campo está vacío o a medias', () => {
    expect(parseToothFilter('')).toEqual({ value: null, invalid: false });
    expect(parseToothFilter('1')).toEqual({ value: null, invalid: false });
    expect(parseToothFilter('8')).toEqual({ value: null, invalid: false });
  });

  it('marca como inválido lo que no es una pieza FDI', () => {
    expect(parseToothFilter('19')).toEqual({ value: null, invalid: true });
    expect(parseToothFilter('49')).toEqual({ value: null, invalid: true });
    expect(parseToothFilter('86')).toEqual({ value: null, invalid: true });
    expect(parseToothFilter('00')).toEqual({ value: null, invalid: true });
  });

  it('ignora lo que no sean dígitos y no pasa de dos cifras', () => {
    expect(parseToothFilter('1a6')).toEqual({ value: 16, invalid: false });
    expect(parseToothFilter('168')).toEqual({ value: 16, invalid: false });
  });
});

describe('historyEventLabel', () => {
  it('nombra los cuatro tipos de cambio del contrato', () => {
    expect(historyEventLabel('registrado')).toBe('Registrado');
    expect(historyEventLabel('actualizado')).toBe('Actualizado');
    expect(historyEventLabel('eliminado')).toBe('Eliminado');
    expect(historyEventLabel('superado')).toBe('Superado');
  });
});

describe('groupHistory (hueco de la Fase 7)', () => {
  it('sin resolutor se comporta igual que la agrupación por día', () => {
    const entradas = [
      entrada({ id: 'a', occurredAt: '2026-10-01T14:00:00.000Z' }),
      entrada({ id: 'b', occurredAt: '2026-10-02T14:00:00.000Z' }),
    ];

    expect(groupHistory(entradas).map((grupo) => grupo.key)).toEqual(
      groupByDay(entradas).map((grupo) => grupo.key),
    );
  });

  it('con resolutor agrupa por sesión clínica aunque cruce de día', () => {
    const sesion = { id: 'ses-9', label: 'Control de octubre' };
    const resolver: HistorySessionResolver = (item) => (item.toothNumber === 16 ? sesion : null);

    const grupos = groupHistory(
      [
        entrada({ id: 'en-sesion-1', occurredAt: '2026-10-01T14:00:00.000Z' }),
        entrada({ id: 'fuera', toothNumber: 26, occurredAt: '2026-10-02T14:00:00.000Z' }),
        entrada({ id: 'en-sesion-2', occurredAt: '2026-10-04T14:00:00.000Z' }),
      ],
      resolver,
    );

    expect(grupos).toHaveLength(2);
    expect(grupos[0]?.key).toBe('sesion:ses-9');
    expect(grupos[0]?.session).toEqual(sesion);
    expect(grupos[0]?.entries.map((item) => item.id)).toEqual(['en-sesion-2', 'en-sesion-1']);
    expect(grupos[1]?.key).toBe('2026-10-02');
    expect(grupos[1]?.session).toBeNull();
  });
});

describe('OdontogramHistory (pintado)', () => {
  // Se pinta en el servidor (`react-dom/server`) para comprobar que el componente
  // real —y no solo las funciones puras— saca a la vista el día, la pieza, la
  // condición, el tipo de cambio, quién lo hizo y las notas.
  const pintar = (entradas: readonly ToothFindingHistoryEntry[]): string =>
    renderToStaticMarkup(createElement(OdontogramHistory, { entries: entradas }));

  it('pinta el día, la pieza, la condición, el estado, el cambio y las notas', () => {
    const html = pintar([
      entrada({ notes: 'Caries en la cara oclusal', actorUsername: null, event: 'actualizado' }),
    ]);

    expect(html).toContain('02/10/2026');
    expect(html).toContain('Pieza 16');
    expect(html).toContain('Pieza completa');
    expect(html).toContain('Corona');
    expect(html).toContain('Pendiente');
    expect(html).toContain('Actualizado');
    expect(html).toContain('Usuario no disponible');
    expect(html).toContain('Caries en la cara oclusal');
    // El color del contrato para `pendiente` viaja en el estilo del rótulo.
    expect(html).toContain('#ef4444');
  });

  it('pinta la cara cuando el hallazgo es de una cara y no de la pieza completa', () => {
    const html = pintar([entrada({ surface: 'occlusal', condition: 'caries' })]);

    expect(html).toContain('Oclusal');
    expect(html).not.toContain('Pieza completa');
  });

  it('muestra el estado vacío cuando todavía no hay cambios', () => {
    expect(pintar([])).toContain('Todavía no hay cambios en el odontograma');
  });
});
