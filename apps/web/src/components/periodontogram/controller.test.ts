import {
  buildPeriodontalChart,
  emptyPeriodontalRiskFactors,
  findPeriodontalTooth,
  periodontalMetrics,
  type PeriodontalExamDetail,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyPeriodontalDigit,
  applyPeriodontalMillimeters,
  applySuggestedDiagnosis,
  clearActiveSite,
  cycleFurcation,
  cycleMobility,
  initialPeriodontalState,
  movePeriodontalCursor,
  nextFurcationGrade,
  nextMobilityGrade,
  periodontalSiteOrder,
  periodontalStateIsDirty,
  savedSnapshotOf,
  selectPeriodontalSite,
  selectPeriodontalTooth,
  setAutoAdvance,
  setPeriodontalExamDate,
  setPeriodontalField,
  toggleFaceFlag,
  toggleGmSign,
  toggleImplantTooth,
  toggleMissingTooth,
  toggleSiteFlag,
  type PeriodontalControllerState,
} from './controller';

/**
 * Pruebas del controlador puro: la boca que se edita con toques y teclas.
 *
 * Son la red de seguridad de la lógica clínica del frontend: que el auto-avance no
 * invente mediciones, que la pieza ausente no conserve sitios (el contrato la
 * rechazaría), que la movilidad y la furca ciclen como dice el plan v1.1 y que la
 * clasificación sugerida no firme un estadio que la evidencia no sostiene.
 */

/** Detalle de examen mínimo para arrancar el controlador en las pruebas. */
const detalle = (overrides: Partial<PeriodontalExamDetail> = {}): PeriodontalExamDetail => {
  const chart = overrides.chart ?? buildPeriodontalChart();
  return {
    id: '00000000-0000-4000-8000-000000000001',
    patientId: '00000000-0000-4000-8000-000000000002',
    status: 'borrador',
    examDate: '2026-10-18',
    revision: 0,
    metrics: periodontalMetrics(chart),
    diagnosis: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    finalizedAt: null,
    recordedByUsername: 'odontologo',
    finalizedByUsername: null,
    printCount: 0,
    lastPrintedAt: null,
    notes: null,
    chart,
    riskFactors: emptyPeriodontalRiskFactors(),
    schemaVersion: 1,
    sessionId: null,
    ...overrides,
  };
};

/** Estado con el cursor en un sitio concreto, para hablar de él sin ambigüedad. */
const enSitio = (
  fdi: number,
  side: 'vestibular' | 'lingual',
  siteIndex: 0 | 1 | 2,
  overrides: Partial<PeriodontalExamDetail> = {},
): PeriodontalControllerState => {
  const state = initialPeriodontalState(detalle(overrides));
  return selectPeriodontalSite(state, fdi, side, siteIndex);
};

/** Sitio del estado actual (para aserciones legibles). */
const sitioDe = (
  state: PeriodontalControllerState,
  fdi: number,
  side: 'vestibular' | 'lingual',
  index: 0 | 1 | 2,
) => {
  const tooth = findPeriodontalTooth(state.chart, fdi);
  expect(tooth).not.toBeNull();
  return side === 'vestibular' ? tooth!.vestibular[index] : tooth!.lingual[index];
};

describe('estado inicial y auto-avance', () => {
  it('arranca en el primer sitio de la primera pieza presente y con el auto-avance apagado', () => {
    const state = initialPeriodontalState(detalle());
    expect(state.cursor).toMatchObject({
      fdi: 18,
      side: 'vestibular',
      siteIndex: 0,
      field: 'pd',
      autoAdvance: false,
      gmNegative: false,
    });
    // Un examen nuevo no hereda mediciones: todos los sitios son null.
    expect(sitioDe(state, 18, 'vestibular', 0).pd).toBeNull();
    expect(sitioDe(state, 18, 'vestibular', 0).gm).toBeNull();
  });

  it('salta las piezas ausentes al elegir el primer sitio', () => {
    const state = initialPeriodontalState(
      detalle({ chart: buildPeriodontalChart({ missing: [18, 17] }) }),
    );
    expect(state.cursor.fdi).toBe(16);
  });

  it('sin auto-avance (el estado inicial) el número se queda en el sitio tocado', () => {
    const state = applyPeriodontalMillimeters(enSitio(18, 'vestibular', 0), 3);
    expect(sitioDe(state, 18, 'vestibular', 0).pd).toBe(3);
    expect(sitioDe(state, 18, 'vestibular', 1).pd).toBeNull();
    expect(state.cursor.siteIndex).toBe(0);
  });

  it('el auto-avance escribe el valor y salta al sitio siguiente, sin tocar otros sitios', () => {
    const state = applyPeriodontalMillimeters(
      setAutoAdvance(enSitio(18, 'vestibular', 0), true),
      4,
    );
    expect(sitioDe(state, 18, 'vestibular', 0).pd).toBe(4);
    expect(sitioDe(state, 18, 'vestibular', 1).pd).toBeNull();
    expect(state.cursor).toMatchObject({ fdi: 18, side: 'vestibular', siteIndex: 1 });
  });

  it('sin auto-avance se queda en el mismo sitio (captura por teclado)', () => {
    const base = setAutoAdvance(enSitio(18, 'vestibular', 0), false);
    const state = applyPeriodontalMillimeters(base, 3);
    expect(sitioDe(state, 18, 'vestibular', 0).pd).toBe(3);
    expect(state.cursor.siteIndex).toBe(0);
  });

  it('el auto-avance salta a la pieza siguiente presente al terminar los seis sitios', () => {
    let state = setAutoAdvance(
      enSitio(18, 'lingual', 2, { chart: buildPeriodontalChart({ missing: [17] }) }),
      true,
    );
    state = applyPeriodontalMillimeters(state, 2);
    // Tras la cara lingual del 18 viene el 16 (el 17 está ausente).
    expect(state.cursor.fdi).toBe(16);
    expect(state.cursor.side).toBe('vestibular');
    expect(state.cursor.siteIndex).toBe(0);
  });

  it('un valor se acota al rango del contrato: PS 0–15 y MG ±', () => {
    const ps = applyPeriodontalMillimeters(enSitio(16, 'vestibular', 0), 99);
    expect(sitioDe(ps, 16, 'vestibular', 0).pd).toBe(15);
    const negativo = applyPeriodontalMillimeters(enSitio(16, 'vestibular', 1), -3);
    expect(sitioDe(negativo, 16, 'vestibular', 1).pd).toBe(0);
  });

  it('dos dígitos seguidos escriben la decena (1 y 2 → 12 mm) y avanzan una sola vez', () => {
    const base = setAutoAdvance(enSitio(18, 'vestibular', 0), true);
    const primero = applyPeriodontalDigit(base, 1, null, 1000);
    expect(sitioDe(primero.state, 18, 'vestibular', 0).pd).toBe(1);
    const segundo = applyPeriodontalDigit(primero.state, 2, primero.pending, 1200);
    expect(sitioDe(segundo.state, 18, 'vestibular', 0).pd).toBe(12);
    expect(segundo.state.cursor).toMatchObject({ fdi: 18, side: 'vestibular', siteIndex: 1 });
    expect(segundo.pending).toBeNull();
  });

  it('fuera de la ventana el segundo dígito es un valor nuevo, no una decena', () => {
    const primero = applyPeriodontalDigit(
      setAutoAdvance(enSitio(18, 'vestibular', 0), true),
      1,
      null,
      1000,
    );
    const tarde = applyPeriodontalDigit(primero.state, 2, primero.pending, 1600);
    expect(sitioDe(tarde.state, 18, 'vestibular', 0).pd).toBe(1);
    expect(sitioDe(tarde.state, 18, 'vestibular', 1).pd).toBe(2);
  });

  it('si algo más cambió el estado, no se compone la decena', () => {
    const primero = applyPeriodontalDigit(
      setAutoAdvance(enSitio(18, 'vestibular', 0), true),
      1,
      null,
      1000,
    );
    const conOtraAccion = setPeriodontalExamDate(primero.state, '2026-01-02');
    const segundo = applyPeriodontalDigit(conOtraAccion, 2, primero.pending, 1200);
    expect(sitioDe(segundo.state, 18, 'vestibular', 0).pd).toBe(1);
    expect(sitioDe(segundo.state, 18, 'vestibular', 1).pd).toBe(2);
  });
});

describe('margen gingival y signo', () => {
  it('escribe recesión con el signo pendiente y permite hasta −15', () => {
    const conSigno = toggleGmSign(setPeriodontalField(enSitio(16, 'vestibular', 0), 'gm'));
    expect(conSigno.cursor.gmNegative).toBe(true);
    const state = applyPeriodontalMillimeters(conSigno, 12);
    expect(sitioDe(state, 16, 'vestibular', 0).gm).toBe(-12);
  });

  it('con signo positivo acota la hiperplasia a +10 (regla del contrato)', () => {
    const state = applyPeriodontalMillimeters(
      setPeriodontalField(enSitio(16, 'vestibular', 0), 'gm'),
      12,
    );
    expect(sitioDe(state, 16, 'vestibular', 0).gm).toBe(10);
  });

  it('el signo también invierte un margen ya escrito y el NIC lo refleja', () => {
    const base = setPeriodontalField(enSitio(16, 'vestibular', 0), 'gm');
    const positivo = applyPeriodontalMillimeters(setAutoAdvance(base, false), 3);
    const negativo = toggleGmSign(positivo);
    expect(sitioDe(negativo, 16, 'vestibular', 0).gm).toBe(-3);
    const conPd = applyPeriodontalMillimeters(
      setPeriodontalField(setAutoAdvance(negativo, false), 'pd'),
      5,
    );
    // NIC = max(0, PS − MG) = 5 − (−3) = 8 (la recesión empeora el nivel de inserción).
    expect(periodontalMetrics(conPd.chart).deepestPd).toBe(5);
    expect(periodontalMetrics(conPd.chart).meanCal).not.toBeNull();
  });
});

describe('flags por sitio y por cara', () => {
  it('conmuta BOP de un sitio sin mover el cursor', () => {
    const state = toggleSiteFlag(enSitio(18, 'vestibular', 1), 'bop');
    expect(sitioDe(state, 18, 'vestibular', 1).bop).toBe(true);
    expect(state.cursor).toMatchObject({ fdi: 18, side: 'vestibular', siteIndex: 1 });
  });

  it('la cara entera se enciende y, pulsada otra vez, se apaga', () => {
    const encendida = toggleFaceFlag(enSitio(18, 'lingual', 0), 'plaque');
    expect(
      [0, 1, 2].map((index) => sitioDe(encendida, 18, 'lingual', index as 0 | 1 | 2).plaque),
    ).toEqual([true, true, true]);
    const apagada = toggleFaceFlag(encendida, 'plaque');
    expect(
      [0, 1, 2].map((index) => sitioDe(apagada, 18, 'lingual', index as 0 | 1 | 2).plaque),
    ).toEqual([false, false, false]);
  });

  it('el sitio activo se puede dejar sin dato (PS, MG y flags)', () => {
    let state = toggleSiteFlag(enSitio(18, 'vestibular', 0), 'suppuration');
    state = applyPeriodontalMillimeters(state, 4);
    // El cursor se recoloca por si el valor escrito lo hubiera movido.
    state = clearActiveSite(selectPeriodontalSite(state, 18, 'vestibular', 0));
    expect(sitioDe(state, 18, 'vestibular', 0)).toEqual({
      pd: null,
      gm: null,
      bop: false,
      plaque: false,
      suppuration: false,
    });
  });
});

describe('movilidad y furca ciclan en un solo toque', () => {
  it('la movilidad recorre ausente → 0 → 1 → 2 → 3 → ausente', () => {
    const desdeAusente = nextMobilityGrade(null);
    const desdeCero = nextMobilityGrade(desdeAusente);
    const desdeUno = nextMobilityGrade(desdeCero);
    const desdeDos = nextMobilityGrade(desdeUno);
    const desdeTres = nextMobilityGrade(desdeDos);
    expect([desdeAusente, desdeCero, desdeUno, desdeDos, desdeTres]).toEqual([0, 1, 2, 3, null]);
  });

  it('la furca recorre sin lesión → I → II → III → sin lesión', () => {
    expect([
      nextFurcationGrade(undefined),
      nextFurcationGrade(1),
      nextFurcationGrade(2),
      nextFurcationGrade(3),
    ]).toEqual([1, 2, 3, null]);
  });

  it('la furca solo cicla las entradas que la anatomía admite', () => {
    // El 16 es molar superior: admite vestibular, mesiopalatina y distopalatina.
    const conFurca = cycleFurcation(enSitio(16, 'vestibular', 0), 16, 'vestibular');
    expect(findPeriodontalTooth(conFurca.chart, 16)?.furcation).toEqual({ vestibular: 1 });
    // El 11 no tiene entradas de furca: no se puede inventar una.
    const sinFurca = cycleFurcation(enSitio(11, 'vestibular', 0), 11, 'vestibular');
    expect(findPeriodontalTooth(sinFurca.chart, 11)?.furcation).toEqual({});
  });

  it('el implante no tiene movilidad ni furca', () => {
    const implantado = toggleImplantTooth(
      initialPeriodontalState(detalle({ chart: buildPeriodontalChart({ implants: [16] }) })),
    );
    const conMovilidad = cycleMobility(selectPeriodontalSite(implantado, 16, 'vestibular', 0));
    expect(findPeriodontalTooth(conMovilidad.chart, 16)?.mobility).toBeNull();
    const conFurca = cycleFurcation(selectPeriodontalSite(implantado, 16, 'vestibular', 0));
    expect(findPeriodontalTooth(conFurca.chart, 16)?.furcation).toEqual({});
  });

  it('ciclar la movilidad de una pieza presente funciona y avanza el ciclo', () => {
    const state = cycleMobility(enSitio(18, 'vestibular', 0));
    expect(findPeriodontalTooth(state.chart, 18)?.mobility).toBe(0);
    const state2 = cycleMobility(state);
    expect(findPeriodontalTooth(state2.chart, 18)?.mobility).toBe(1);
  });
});

describe('pieza ausente e implante', () => {
  it('marcar ausente limpia sitios, movilidad y furca (el contrato lo exige)', () => {
    let state = applyPeriodontalMillimeters(enSitio(18, 'vestibular', 0), 5);
    state = cycleMobility(state);
    state = toggleMissingTooth(state, 18);
    const tooth = findPeriodontalTooth(state.chart, 18);
    expect(tooth?.missing).toBe(true);
    expect(tooth?.mobility).toBeNull();
    expect(tooth?.furcation).toEqual({});
    expect(tooth?.vestibular.every((site) => site.pd === null)).toBe(true);
    expect(tooth?.lingual.every((site) => site.pd === null)).toBe(true);
  });

  it('si la pieza activa queda ausente, el cursor salta a otra presente', () => {
    const state = toggleMissingTooth(enSitio(18, 'vestibular', 0), 18);
    expect(state.cursor.fdi).not.toBe(18);
    expect(findPeriodontalTooth(state.chart, state.cursor.fdi)?.missing).toBeFalsy();
  });

  it('el implante se sigue pudiendo sondar (mucositis/periimplantitis)', () => {
    let state = toggleImplantTooth(enSitio(16, 'vestibular', 0), 16);
    state = applyPeriodontalMillimeters(state, 3);
    expect(sitioDe(state, 16, 'vestibular', 0).pd).toBe(3);
    expect(findPeriodontalTooth(state.chart, 16)?.implant).toBe(true);
  });

  it('se puede enfocar una pieza ausente para devolverla a la boca', () => {
    // Los sitios de la pieza ausente no se dibujan: sin esto no habría forma
    // táctil de seleccionarla y desmarcarla.
    const ausente = selectPeriodontalTooth(
      initialPeriodontalState(detalle({ chart: buildPeriodontalChart({ missing: [16] }) })),
      16,
    );
    expect(ausente.cursor.fdi).toBe(16);
    const vuelta = toggleMissingTooth(ausente);
    expect(findPeriodontalTooth(vuelta.chart, 16)?.missing).toBe(false);
    expect(vuelta.cursor.fdi).toBe(16);
  });

  it('un FDI que no está en el examen no mueve el cursor', () => {
    const base = initialPeriodontalState(detalle());
    expect(selectPeriodontalTooth(base, 99)).toBe(base);
  });
});

describe('navegación del cursor', () => {
  it('ordena los sitios por pieza, vestibular y después lingual', () => {
    const order = periodontalSiteOrder(buildPeriodontalChart({ missing: [17] }));
    expect(order[0]).toEqual({ fdi: 18, side: 'vestibular', index: 0 });
    expect(order[5]).toEqual({ fdi: 18, side: 'lingual', index: 2 });
    expect(order[6]).toEqual({ fdi: 16, side: 'vestibular', index: 0 });
  });

  it('las flechas se mueven dentro de la cara y entre caras según la arcada', () => {
    const base = enSitio(18, 'vestibular', 0);
    expect(movePeriodontalCursor(base, 'left')).toBe(base);
    expect(movePeriodontalCursor(base, 'right').cursor.siteIndex).toBe(1);
    // Maxilar: vestibular está arriba y lingual abajo.
    expect(movePeriodontalCursor(base, 'down').cursor.side).toBe('lingual');
    expect(movePeriodontalCursor(base, 'up')).toBe(base);
    // Mandíbula: la lingual es la de arriba, así que «bajar» desde vestibular no va a
    // ninguna banda (la vestibular es la de abajo).
    expect(movePeriodontalCursor(enSitio(48, 'vestibular', 0), 'up').cursor.side).toBe('lingual');
    expect(movePeriodontalCursor(enSitio(48, 'vestibular', 0), 'down')).toEqual(
      enSitio(48, 'vestibular', 0),
    );
  });

  it('next/previous recorren los sitios presentes sin parar en las ausentes', () => {
    const base = selectPeriodontalSite(
      initialPeriodontalState(detalle({ chart: buildPeriodontalChart({ missing: [17] }) })),
      18,
      'lingual',
      2,
    );
    const next = movePeriodontalCursor(base, 'next');
    expect(next.cursor.fdi).toBe(16);
    const previous = movePeriodontalCursor(next, 'previous');
    expect(previous.cursor).toMatchObject({ fdi: 18, side: 'lingual', siteIndex: 2 });
  });

  it('nextTooth/previousTooth cambian de pieza conservando cara y sitio', () => {
    const state = selectPeriodontalSite(initialPeriodontalState(detalle()), 18, 'vestibular', 1);
    const next = movePeriodontalCursor(state, 'nextTooth');
    expect(next.cursor).toMatchObject({ fdi: 17, side: 'vestibular', siteIndex: 1 });
    const previous = movePeriodontalCursor(next, 'previousTooth');
    expect(previous.cursor.fdi).toBe(18);
  });
});

describe('diagnóstico sugerido y cambio sin guardar', () => {
  it('sin mediciones no se sugiere estadio y no se firma nada', () => {
    const state = applySuggestedDiagnosis(initialPeriodontalState(detalle()));
    expect(state.diagnosis).toBeNull();
  });

  it('con una bolsa profunda sugiere estadio y grado, y se pueden firmar', () => {
    let state = enSitio(16, 'vestibular', 0);
    state = applyPeriodontalMillimeters(state, 7);
    const firmado = applySuggestedDiagnosis(state);
    expect(firmado.diagnosis).not.toBeNull();
    expect(firmado.diagnosis?.stage).toBe(3);
    expect(firmado.diagnosis?.grade).toBe('A');
  });

  it('detecta cambios comparando referencias, sin recorrer los 192 sitios', () => {
    const state = initialPeriodontalState(detalle());
    const saved = savedSnapshotOf(state);
    expect(periodontalStateIsDirty(state, saved)).toBe(false);
    expect(periodontalStateIsDirty(setPeriodontalExamDate(state, '2026-10-19'), saved)).toBe(true);
    const editado = applyPeriodontalMillimeters(state, 2);
    expect(periodontalStateIsDirty(editado, saved)).toBe(true);
    expect(periodontalStateIsDirty(editado, savedSnapshotOf(editado))).toBe(false);
  });
});
