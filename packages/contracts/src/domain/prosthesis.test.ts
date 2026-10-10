import { describe, expect, it } from 'vitest';

import { archLayout } from './odontogram.js';
import {
  archOfTooth,
  archTeeth,
  prosthesisSummaryLabel,
  prosthesisTrack,
  prosthesesOverlap,
  recordProsthesisSchema,
  sameTeeth,
  sharedTeeth,
  teethAreContiguous,
  type ProsthesisRecord,
} from './prosthesis.js';

describe('prótesis removibles (PPR/PRT)', () => {
  it('cada arcada tiene sus 16 piezas en orden anatómico continuo', () => {
    const maxilar = archTeeth('maxilar');
    expect(maxilar[0]).toBe(18);
    expect(maxilar[7]).toBe(11);
    expect(maxilar[8]).toBe(21);
    expect(maxilar[15]).toBe(28);
    expect(archTeeth('mandibula')[0]).toBe(48);
    expect(archTeeth('mandibula')[15]).toBe(38);
  });

  it('deduce la arcada de una pieza permanente y descarta la temporal', () => {
    expect(archOfTooth(16)).toBe('maxilar');
    expect(archOfTooth(41)).toBe('mandibula');
    expect(archOfTooth(55)).toBeNull();
  });

  it('un tramo es contiguo dentro de la arcada, aunque cruce la línea media', () => {
    expect(teethAreContiguous([14, 15, 16], 'maxilar')).toBe(true);
    expect(teethAreContiguous([14, 16], 'maxilar')).toBe(false);
    expect(teethAreContiguous([11, 21], 'maxilar')).toBe(true);
  });

  it('la PPR exige tramo contiguo dentro de la arcada', () => {
    expect(
      recordProsthesisSchema.safeParse({
        kind: 'ppr',
        arch: 'maxilar',
        toothNumbers: [14, 15, 16],
      }).success,
    ).toBe(true);
    // Tramo con un hueco: no es un tramo.
    expect(
      recordProsthesisSchema.safeParse({
        kind: 'ppr',
        arch: 'maxilar',
        toothNumbers: [14, 16],
      }).success,
    ).toBe(false);
    // Piezas de otra arcada.
    expect(
      recordProsthesisSchema.safeParse({
        kind: 'ppr',
        arch: 'maxilar',
        toothNumbers: [14, 41],
      }).success,
    ).toBe(false);
  });

  it('la PRT tiene que cubrir la arcada completa', () => {
    expect(
      recordProsthesisSchema.safeParse({
        kind: 'prt',
        arch: 'mandibula',
        toothNumbers: archTeeth('mandibula'),
      }).success,
    ).toBe(true);
    expect(
      recordProsthesisSchema.safeParse({
        kind: 'prt',
        arch: 'mandibula',
        toothNumbers: [41, 42, 43],
      }).success,
    ).toBe(false);
  });

  it('el tramo de la doble línea abarca el rango (PPR) o la arcada entera (PRT)', () => {
    const layout = archLayout('permanente');
    const trackPpr = prosthesisTrack(
      { kind: 'ppr', arch: 'maxilar', toothNumbers: [14, 15, 16] },
      layout,
    );
    const trackPrt = prosthesisTrack(
      { kind: 'prt', arch: 'mandibula', toothNumbers: [...archTeeth('mandibula')] },
      layout,
    );

    expect(trackPpr).not.toBeNull();
    expect(trackPrt).not.toBeNull();
    // La PRT ocupa de borde a borde la arcada; la PPR, solo su tramo.
    expect(trackPrt?.x1).toBe(0);
    expect(trackPpr?.x2).toBeLessThan(trackPrt?.x2 ?? 0);
    expect(trackPpr?.x2).toBeGreaterThan(trackPpr?.x1 ?? 0);
  });

  it('etiqueta corta: `PPR 14–16` y `PRT <arcada>`', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000000',
      state: 'pendiente' as const,
      notes: null,
      recordedByUsername: null,
      recordedAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
      sessionId: null,
    };
    const ppr: ProsthesisRecord = {
      ...base,
      kind: 'ppr',
      arch: 'maxilar',
      toothNumbers: [14, 15, 16],
    };
    const prt: ProsthesisRecord = {
      ...base,
      kind: 'prt',
      arch: 'mandibula',
      toothNumbers: [...archTeeth('mandibula')],
    };
    expect(prosthesisSummaryLabel(ppr)).toBe('PPR 14–16');
    expect(prosthesisSummaryLabel(prt)).toBe('PRT Mandíbula inferior');
  });
});

describe('convivencia de prótesis en una arcada (solape de piezas)', () => {
  it('sameTeeth compara conjuntos, sin importar el orden', () => {
    expect(sameTeeth([14, 15, 16], [16, 14, 15])).toBe(true);
    expect(sameTeeth([14, 15, 16], [14, 15])).toBe(false);
    expect(sameTeeth([14, 15, 16], [14, 15, 17])).toBe(false);
  });

  it('sharedTeeth devuelve la intersección ordenada', () => {
    expect(sharedTeeth([14, 15, 16], [16, 17, 18])).toEqual([16]);
    expect(sharedTeeth([14, 15, 16], [24, 25, 26])).toEqual([]);
  });

  it('dos parciales se solapan solo si sus tramos se pisan', () => {
    expect(prosthesesOverlap([14, 15, 16], [24, 25, 26])).toBe(false);
    expect(prosthesesOverlap([14, 15, 16], [16, 17])).toBe(true);
    expect(prosthesesOverlap([14, 15, 16], [15, 16])).toBe(true);
  });

  it('la total, que cubre toda la arcada, se solapa con cualquier otra', () => {
    const todaLaArcada = [...archTeeth('maxilar')];
    expect(prosthesesOverlap(todaLaArcada, [14, 15, 16])).toBe(true);
    expect(prosthesesOverlap(todaLaArcada, todaLaArcada)).toBe(true);
    // Otra arcada no se toca: comparar piezas ya lo separa.
    expect(prosthesesOverlap([14, 15, 16], [34, 35, 36])).toBe(false);
  });
});
