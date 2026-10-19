import { describe, expect, it } from 'vitest';

import {
  ALLOWED_FURCATIONS_BY_FDI,
  FURCATION_ENTRANCES,
  FURCATION_ENTRANCE_LABELS,
  MOBILITY_GRADES,
  PERIODONTAL_EVIDENCE_CODES,
  PERIODONTAL_GRADES,
  PERIODONTAL_LOWER_TEETH,
  PERIODONTAL_SCHEMA_VERSION,
  PERIODONTAL_SITES_PER_TOOTH,
  PERIODONTAL_SITE_ANATOMIES,
  PERIODONTAL_STAGE_LABELS,
  PERIODONTAL_TEETH,
  PERIODONTAL_UPPER_TEETH,
  SITE_ANATOMY_SHORT_LABELS,
  analyzePeriodontalChart,
  attachmentLevel,
  buildPeriodontalChart,
  comparePeriodontalCharts,
  createPeriodontalExamSchema,
  finalizePeriodontalExamSchema,
  findPeriodontalSite,
  findPeriodontalTooth,
  isInterproximalSite,
  periodontalChartSchema,
  periodontalExamListQuerySchema,
  periodontalMetrics,
  savePeriodontalExamSchema,
  siteAnatomy,
  siteIsMesial,
  siteShortLabel,
  sitesOfTooth,
  suggestPeriodontalDiagnosis,
  type PeriodontalChart,
  type PeriodontalChartSeed,
  type PeriodontalTooth,
} from './periodontogram.js';

/**
 * Pruebas del contrato del periodontograma: lo que el servidor y la interfaz
 * comparten. Se comprueba sobre todo lo que, si se rompe, se rompe **en silencio**:
 * la orientación anatómica de los sitios (izquierda de la pantalla ≠ mesial), los
 * índices con denominador de sitios medidos y la clasificación sugerida.
 */

const piece = (chart: PeriodontalChart, fdi: number): PeriodontalTooth => {
  const tooth = findPeriodontalTooth(chart, fdi);
  if (tooth === null) throw new Error(`La pieza ${String(fdi)} no está en la boca`);
  return tooth;
};

/** Boca canónica con los sitios de una pieza rellenados a mano. */
const chartWith = (
  fill: (tooth: PeriodontalTooth) => void,
  seed: PeriodontalChartSeed = {},
): PeriodontalChart => {
  const chart = buildPeriodontalChart(seed);
  for (const tooth of chart) fill(tooth);
  return chart;
};

const site = (input: {
  pd: number | null;
  gm: number | null;
  bop?: boolean;
  plaque?: boolean;
  suppuration?: boolean;
}): PeriodontalTooth['vestibular'][number] => ({
  pd: input.pd,
  gm: input.gm,
  bop: input.bop ?? false,
  plaque: input.plaque ?? false,
  suppuration: input.suppuration ?? false,
});

/** Errores de un esquema, o `null` si validó. Evita el estrechamiento manual. */
const issuesOf = (
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      error?: { issues: Array<{ message: string }> };
    };
  },
  value: unknown,
): Array<{ message: string }> | null => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  return parsed.error?.issues ?? [];
};

describe('orden canónico y piezas del periodontograma', () => {
  it('las 32 piezas van del maxilar a la mandíbula y de derecha a izquierda del paciente', () => {
    expect(PERIODONTAL_UPPER_TEETH).toEqual([
      18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
    ]);
    expect(PERIODONTAL_LOWER_TEETH).toEqual([
      48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
    ]);
    expect(PERIODONTAL_TEETH).toHaveLength(32);
    expect(new Set(PERIODONTAL_TEETH).size).toBe(32);
  });

  it('cada pieza tiene 6 sitios y la boca vacía no inventa mediciones', () => {
    const chart = buildPeriodontalChart();

    expect(chart).toHaveLength(32);
    expect(chart.map((tooth) => tooth.fdi)).toEqual(PERIODONTAL_TEETH);

    for (const tooth of chart) {
      expect(sitesOfTooth(tooth)).toHaveLength(PERIODONTAL_SITES_PER_TOOTH);
      for (const { site: sitio } of sitesOfTooth(tooth)) {
        expect(sitio).toEqual({
          pd: null,
          gm: null,
          bop: false,
          plaque: false,
          suppuration: false,
        });
      }
      expect(tooth.mobility).toBeNull();
      expect(tooth.furcation).toEqual({});
    }
    expect(PERIODONTAL_SCHEMA_VERSION).toBe(1);
  });

  it('el odontograma marca ausencias e implantes al abrir el examen', () => {
    const chart = buildPeriodontalChart({ missing: [18, 36], implants: [46] });
    expect(piece(chart, 18).missing).toBe(true);
    expect(piece(chart, 18).implant).toBe(false);
    expect(piece(chart, 36).missing).toBe(true);
    expect(piece(chart, 46).implant).toBe(true);
    expect(piece(chart, 46).missing).toBe(false);
  });

  it('encuentra piezas y sitios por su identidad', () => {
    const chart = buildPeriodontalChart();
    piece(chart, 16).vestibular[1] = site({ pd: 3, gm: 0, bop: true });

    expect(findPeriodontalTooth(chart, 16)?.fdi).toBe(16);
    expect(findPeriodontalTooth(chart, 99)).toBeNull();
    expect(findPeriodontalSite(chart, 16, 'vestibular', 1)?.pd).toBe(3);
    expect(findPeriodontalSite(chart, 16, 'lingual', 1)?.pd).toBeNull();
    expect(findPeriodontalSite(chart, 99, 'lingual', 1)).toBeNull();
  });
});

describe('orientación anatómica de los sitios', () => {
  it('en los cuadrantes derechos la izquierda de la pantalla es distal', () => {
    expect(['distovestibular', 'vestibular', 'mesiovestibular']).toEqual([
      siteAnatomy(16, 'vestibular', 0),
      siteAnatomy(16, 'vestibular', 1),
      siteAnatomy(16, 'vestibular', 2),
    ]);
    expect(siteIsMesial(16, 0)).toBe(false);
    expect(siteIsMesial(16, 2)).toBe(true);
    expect(siteShortLabel(46, 'vestibular', 0)).toBe('DV');
  });

  it('en los cuadrantes izquierdos la izquierda de la pantalla es mesial', () => {
    expect(siteAnatomy(26, 'vestibular', 0)).toBe('mesiovestibular');
    expect(siteAnatomy(26, 'vestibular', 2)).toBe('distovestibular');
    expect(siteIsMesial(26, 0)).toBe(true);
    expect(siteAnatomy(36, 'lingual', 0)).toBe('mesiolingual');
    expect(siteShortLabel(36, 'lingual', 2)).toBe('DL');
  });

  it('la cara interna se llama palatina arriba y lingual abajo', () => {
    expect(siteAnatomy(16, 'lingual', 1)).toBe('palatino');
    expect(siteAnatomy(46, 'lingual', 1)).toBe('lingual');
    expect(siteAnatomy(16, 'vestibular', 1)).toBe('vestibular');
  });

  it('los 9 nombres anatómicos son alcanzables y tienen etiqueta corta', () => {
    const names = new Set<string>();
    for (const fdi of PERIODONTAL_TEETH) {
      for (const side of ['vestibular', 'lingual'] as const) {
        for (const index of [0, 1, 2] as const) {
          names.add(siteAnatomy(fdi, side, index));
        }
      }
    }
    expect([...names].sort()).toEqual([...PERIODONTAL_SITE_ANATOMIES].sort());
    for (const name of PERIODONTAL_SITE_ANATOMIES) {
      expect(SITE_ANATOMY_SHORT_LABELS[name].trim().length).toBeGreaterThan(0);
    }
  });

  it('el centro de la cara no es interproximal', () => {
    expect(isInterproximalSite(0)).toBe(true);
    expect(isInterproximalSite(1)).toBe(false);
    expect(isInterproximalSite(2)).toBe(true);
  });
});

describe('reglas de furca y movilidad', () => {
  it('el mapa anatómico solo abre las entradas que existen', () => {
    expect(ALLOWED_FURCATIONS_BY_FDI[16]).toEqual(['vestibular', 'mesiopalatina', 'distopalatina']);
    expect(ALLOWED_FURCATIONS_BY_FDI[36]).toEqual(['vestibular', 'lingual']);
    expect(ALLOWED_FURCATIONS_BY_FDI[14]).toEqual(['mesial', 'distal']);
    expect(ALLOWED_FURCATIONS_BY_FDI[15]).toBeUndefined();
    expect(ALLOWED_FURCATIONS_BY_FDI[11]).toBeUndefined();
    expect(ALLOWED_FURCATIONS_BY_FDI[45]).toBeUndefined();
  });

  it('cada entrada de furca tiene etiqueta para la interfaz', () => {
    for (const entrada of FURCATION_ENTRANCES) {
      expect(FURCATION_ENTRANCE_LABELS[entrada].trim().length).toBeGreaterThan(0);
    }
    for (const grado of MOBILITY_GRADES) {
      expect(Number.isInteger(grado)).toBe(true);
    }
  });

  it('el esquema rechaza una furca en una pieza sin furca', () => {
    const chart = buildPeriodontalChart();
    piece(chart, 15).furcation = { vestibular: 2 };

    const issues = issuesOf(periodontalChartSchema, chart);
    expect(issues).not.toBeNull();
    expect(issues?.[0]?.message).toContain('15');
    expect(issues?.[0]?.message).toMatch(/no tiene entradas de furca/);
  });

  it('el esquema rechaza una entrada de furca que la pieza no tiene', () => {
    const chart = buildPeriodontalChart();
    // El primer molar inferior no tiene entrada mesiopalatina.
    piece(chart, 36).furcation = { mesiopalatina: 1 };

    const issues = issuesOf(periodontalChartSchema, chart);
    expect(issues).not.toBeNull();
    expect(issues?.[0]?.message).toMatch(/solo admite las furcas/);
  });

  it('el esquema rechaza movilidad y furca en un implante', () => {
    const conMovilidad = buildPeriodontalChart({ implants: [46] });
    piece(conMovilidad, 46).mobility = 1;
    const issuesMovilidad = issuesOf(periodontalChartSchema, conMovilidad);
    expect(issuesMovilidad).not.toBeNull();
    expect(issuesMovilidad?.some((issue) => issue.message.includes('movilidad'))).toBe(true);

    const conFurca = buildPeriodontalChart({ implants: [46] });
    piece(conFurca, 46).furcation = { vestibular: 1 };
    const issuesFurca = issuesOf(periodontalChartSchema, conFurca);
    expect(issuesFurca).not.toBeNull();
    expect(issuesFurca?.some((issue) => issue.message.includes('no tiene furca'))).toBe(true);
  });
});

describe('la pieza ausente no admite datos', () => {
  it('rechaza sitios medidos y movilidad en una pieza ausente', () => {
    const conSitio = buildPeriodontalChart({ missing: [36] });
    piece(conSitio, 36).vestibular[0] = site({ pd: 4, gm: 0, bop: true });
    expect(issuesOf(periodontalChartSchema, conSitio)).not.toBeNull();

    const conMovilidad = buildPeriodontalChart({ missing: [36] });
    piece(conMovilidad, 36).mobility = 1;
    expect(issuesOf(periodontalChartSchema, conMovilidad)).not.toBeNull();
  });

  it('rechaza la pieza ausente y a la vez implante', () => {
    const chart = buildPeriodontalChart();
    piece(chart, 36).missing = true;
    piece(chart, 36).implant = true;
    const issues = issuesOf(periodontalChartSchema, chart);
    expect(issues).not.toBeNull();
    expect(issues?.some((issue) => issue.message.match(/ausente y ser un implante/))).toBe(true);
  });
});

describe('orden del arreglo de piezas', () => {
  it('rechaza piezas desordenadas', () => {
    const chart = buildPeriodontalChart();
    const desordenado = [chart[1], chart[0], ...chart.slice(2)];
    const issues = issuesOf(periodontalChartSchema, desordenado);
    expect(issues).not.toBeNull();
    expect(issues?.[0]?.message).toMatch(/Pieza fuera de orden/);
  });

  it('rechaza una boca incompleta', () => {
    expect(issuesOf(periodontalChartSchema, buildPeriodontalChart().slice(0, 31))).not.toBeNull();
  });

  it('acepta la boca canónica y rellena los valores por defecto', () => {
    const minimal = buildPeriodontalChart().map((tooth) => ({
      fdi: tooth.fdi,
      vestibular: tooth.vestibular.map(() => ({})),
      lingual: tooth.lingual.map(() => ({})),
    }));
    const parsed = periodontalChartSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data[0]?.missing).toBe(false);
      expect(parsed.data[0]?.mobility).toBeNull();
      expect(parsed.data[0]?.vestibular[0]?.pd).toBeNull();
    }
  });
});

describe('nivel de inserción clínica (NIC)', () => {
  it('los cuatro escenarios clínicos de las bases teóricas', () => {
    // A: pseudobolsa por hiperplasia (PS 5, MG +3) → NIC 2.
    expect(attachmentLevel({ pd: 5, gm: 3 })).toBe(2);
    // B: bolsa verdadera sin recesión → NIC 5.
    expect(attachmentLevel({ pd: 5, gm: 0 })).toBe(5);
    // C: bolsa con recesión severa → NIC 9.
    expect(attachmentLevel({ pd: 5, gm: -4 })).toBe(9);
    // D: recesión pura con surco sano → NIC 6.
    expect(attachmentLevel({ pd: 2, gm: -4 })).toBe(6);
  });

  it('sin PS no hay NIC; sin MG se asume el LAC solo para el cálculo', () => {
    expect(attachmentLevel({ pd: null, gm: -4 })).toBeNull();
    expect(attachmentLevel({ pd: 4, gm: null })).toBe(4);
  });

  it('el NIC no baja de cero (margen coronal al fondo del surco)', () => {
    expect(attachmentLevel({ pd: 1, gm: 3 })).toBe(0);
  });
});

describe('métricas agregadas', () => {
  const base = chartWith((tooth) => {
    if (tooth.fdi === 16) {
      tooth.vestibular[0] = site({ pd: 5, gm: -2, bop: true });
      tooth.vestibular[1] = site({ pd: 3, gm: 0, plaque: true });
      tooth.vestibular[2] = site({ pd: 4, gm: 0, bop: true });
      tooth.lingual[0] = site({ pd: 5, gm: -1, suppuration: true });
      tooth.mobility = 1;
      tooth.furcation = { vestibular: 2 };
    }
  });

  /** La misma boca con una ausencia (18) y un implante (28) para separar bloques. */
  const chart = (() => {
    const boca = buildPeriodontalChart({ missing: [18], implants: [28] });
    const original = piece(base, 16);
    const copia = piece(boca, 16);
    copia.vestibular = original.vestibular;
    copia.lingual = original.lingual;
    copia.mobility = original.mobility;
    copia.furcation = original.furcation;
    piece(boca, 28).vestibular[0] = site({ pd: 4, gm: 0, bop: true });
    return boca;
  })();

  it('los índices usan como denominador los sitios medidos', () => {
    const metrics = periodontalMetrics(chart);

    expect(metrics.teethPresent).toBe(30);
    expect(metrics.teethMissing).toBe(1);
    expect(metrics.implants).toBe(1);
    expect(metrics.sitesPresent).toBe(30 * 6);
    expect(metrics.sitesProbed).toBe(4);
    expect(metrics.bopSites).toBe(2);
    expect(metrics.bopPercent).toBe(50);
    expect(metrics.plaqueSites).toBe(1);
    expect(metrics.plaquePercent).toBe(25);
    expect(metrics.suppurationSites).toBe(1);
  });

  it('resume PS, NIC y bolsas con los umbrales clínicos', () => {
    const metrics = periodontalMetrics(chart);

    expect(metrics.meanPd).toBe(4.3);
    expect(metrics.meanCal).toBe(5);
    expect(metrics.deepestPd).toBe(5);
    expect(metrics.worstCal).toBe(7);
    expect(metrics.worstInterproximalCal).toBe(7);
    expect(metrics.pocketsGte4).toBe(3);
    expect(metrics.pocketsGte5).toBe(2);
    expect(metrics.pocketsGte6).toBe(0);
    expect(metrics.bleedingPocketsGte4).toBe(2);
    // Retratamiento: dos bolsas ≥ 5 mm y una bolsa de 4 mm que sangra.
    expect(metrics.retreatmentSites).toBe(3);
    expect(metrics.furcationLesions).toBe(1);
    expect(metrics.worstFurcation).toBe(2);
    expect(metrics.mobilityGte1).toBe(1);
    expect(metrics.mobilityGte2).toBe(0);
  });

  it('calcula el bloque de implantes aparte de la dentición natural', () => {
    const metrics = periodontalMetrics(chart);

    expect(metrics.implant.implants).toBe(1);
    expect(metrics.implant.sitesProbed).toBe(1);
    expect(metrics.implant.bopSites).toBe(1);
    expect(metrics.implant.bopPercent).toBe(100);
    expect(metrics.implant.meanPd).toBe(4);
    expect(metrics.implant.meanCal).toBe(4);
    expect(metrics.implant.deepestPd).toBe(4);
    expect(metrics.implant.pocketsGte5).toBe(0);
  });

  it('una boca vacía no divide por cero', () => {
    const metrics = periodontalMetrics(buildPeriodontalChart());
    expect(metrics.sitesProbed).toBe(0);
    expect(metrics.bopPercent).toBeNull();
    expect(metrics.plaquePercent).toBeNull();
    expect(metrics.meanPd).toBeNull();
    expect(metrics.meanCal).toBeNull();
    expect(metrics.deepestPd).toBeNull();
    expect(metrics.worstCal).toBeNull();
    expect(metrics.worstInterproximalCal).toBeNull();
    expect(metrics.furcationLesions).toBe(0);
  });
});

describe('clasificación AAP/EFP 2018 sugerida', () => {
  const sinRiesgos = { smoking: 'no', diabetes: 'no', hba1c: null } as const;

  it('sin criterios medibles no sugiere estadio y asume grado A', () => {
    const analysis = analyzePeriodontalChart(buildPeriodontalChart());
    expect(analysis.suggestion.stage).toBeNull();
    expect(analysis.suggestion.grade).toBe('A');
    expect(analysis.suggestion.evidence).toEqual([]);
  });

  it('sugiere estadio I con NIC interproximal de 1 a 2 mm', () => {
    const chart = buildPeriodontalChart();
    // PS 2 con hiperplasia de 1 mm: el NIC real es 1 mm (pseudobolsa).
    piece(chart, 16).vestibular[0] = site({ pd: 2, gm: 1, bop: true });
    expect(suggestPeriodontalDiagnosis(periodontalMetrics(chart), sinRiesgos).stage).toBe(1);
  });

  it('sugiere estadio II con NIC interproximal de 3 a 4 mm', () => {
    const chart = buildPeriodontalChart();
    piece(chart, 16).vestibular[0] = site({ pd: 4, gm: 0 });
    expect(suggestPeriodontalDiagnosis(periodontalMetrics(chart), sinRiesgos).stage).toBe(2);
  });

  it('sugiere estadio III por NIC ≥ 5, bolsa ≥ 6 o furca grado II', () => {
    const porNic = buildPeriodontalChart();
    piece(porNic, 16).vestibular[0] = site({ pd: 5, gm: 0, bop: true });
    expect(suggestPeriodontalDiagnosis(periodontalMetrics(porNic), sinRiesgos).stage).toBe(3);

    const porBolsa = buildPeriodontalChart();
    piece(porBolsa, 16).vestibular[1] = site({ pd: 6, gm: 0 });
    expect(suggestPeriodontalDiagnosis(periodontalMetrics(porBolsa), sinRiesgos).stage).toBe(3);

    const porFurca = buildPeriodontalChart();
    piece(porFurca, 16).furcation = { vestibular: 2 };
    const sugerencia = suggestPeriodontalDiagnosis(periodontalMetrics(porFurca), sinRiesgos);
    expect(sugerencia.stage).toBe(3);
    expect(sugerencia.evidence.map((item) => item.code)).toContain('furca_avanzada');
  });

  it('sugiere estadio IV con cinco o más piezas perdidas', () => {
    const chart = buildPeriodontalChart({ missing: [18, 17, 16, 15, 14] });
    const { suggestion } = analyzePeriodontalChart(chart);
    expect(suggestion.stage).toBe(4);
    expect(suggestion.evidence.map((item) => item.code)).toContain('dientes_perdidos');
  });

  it('el grado sale de los factores de riesgo declarados', () => {
    const metrics = periodontalMetrics(buildPeriodontalChart());

    expect(suggestPeriodontalDiagnosis(metrics, { ...sinRiesgos, smoking: 'menos10' }).grade).toBe(
      'B',
    );
    expect(suggestPeriodontalDiagnosis(metrics, { ...sinRiesgos, smoking: 'mas10' }).grade).toBe(
      'C',
    );
    expect(
      suggestPeriodontalDiagnosis(metrics, { ...sinRiesgos, diabetes: 'controlada' }).grade,
    ).toBe('B');
    expect(
      suggestPeriodontalDiagnosis(metrics, { ...sinRiesgos, diabetes: 'descontrolada' }).grade,
    ).toBe('C');
    expect(
      suggestPeriodontalDiagnosis(metrics, {
        ...sinRiesgos,
        diabetes: 'controlada',
        hba1c: 7.4,
      }).grade,
    ).toBe('C');
    expect(
      suggestPeriodontalDiagnosis(metrics, {
        ...sinRiesgos,
        diabetes: 'controlada',
        hba1c: 6.8,
      }).grade,
    ).toBe('B');
  });

  it('los códigos de evidencia son traducibles y no se repiten', () => {
    const chart = buildPeriodontalChart({ missing: [18] });
    const { suggestion } = analyzePeriodontalChart(chart, {
      smoking: 'mas10',
      diabetes: 'descontrolada',
      hba1c: 8,
    });
    const codigos = suggestion.evidence.map((item) => item.code);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const codigo of codigos) {
      expect(PERIODONTAL_EVIDENCE_CODES).toContain(codigo);
    }
    for (const label of Object.values(PERIODONTAL_STAGE_LABELS)) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
    for (const grade of PERIODONTAL_GRADES) {
      expect(grade).toMatch(/^[ABC]$/);
    }
  });
});

describe('comparación longitudinal', () => {
  it('marca mejoría y empeoramiento con el umbral de 2 mm y cuenta bolsas nuevas', () => {
    const anterior = buildPeriodontalChart();
    piece(anterior, 16).vestibular[0] = site({ pd: 6, gm: 0, bop: true });
    piece(anterior, 16).vestibular[1] = site({ pd: 2, gm: 0 });
    piece(anterior, 36).vestibular[0] = site({ pd: 2, gm: 0 });

    const actual = buildPeriodontalChart();
    piece(actual, 16).vestibular[0] = site({ pd: 3, gm: 0 });
    piece(actual, 16).vestibular[1] = site({ pd: 4, gm: 0 });
    piece(actual, 36).vestibular[0] = site({ pd: 5, gm: 0, bop: true });

    const comparison = comparePeriodontalCharts({
      previousExamId: 'examen-anterior',
      previous: anterior,
      currentExamId: 'examen-actual',
      current: actual,
    });

    const sitio16 = comparison.sites.find(
      (sitio) => sitio.fdi === 16 && sitio.side === 'vestibular' && sitio.index === 0,
    );
    expect(sitio16?.change).toBe('mejoro');
    expect(sitio16?.deltaPd).toBe(-3);

    const sitio36 = comparison.sites.find(
      (sitio) => sitio.fdi === 36 && sitio.side === 'vestibular' && sitio.index === 0,
    );
    expect(sitio36?.change).toBe('empeoro');
    expect(sitio36?.newPocket).toBe(true);

    expect(comparison.sites).toHaveLength(32 * 6);
    expect(comparison.summary.newPocketsGte5).toBe(1);
    expect(comparison.summary.resolvedPocketsGte5).toBe(1);
    expect(comparison.summary.improved).toBe(1);
    expect(comparison.summary.worsened).toBe(2);
    expect(comparison.summary.stable).toBe(0);
  });

  it('registra la pieza que se perdió entre exámenes', () => {
    const comparison = comparePeriodontalCharts({
      previousExamId: 'a',
      previous: buildPeriodontalChart(),
      currentExamId: 'b',
      current: buildPeriodontalChart({ missing: [18] }),
    });
    expect(comparison.summary.teethLost).toBe(1);
    expect(comparison.summary.teethGained).toBe(0);
    expect(comparison.sites.filter((sitio) => sitio.change === 'sin_actual')).toHaveLength(6);
  });

  it('distingue el sitio sin medición anterior del sitio ausente en la boca', () => {
    const anterior = buildPeriodontalChart();
    const actual = buildPeriodontalChart();
    piece(actual, 16).vestibular[0] = site({ pd: 3, gm: 0 });

    const comparison = comparePeriodontalCharts({
      previousExamId: 'a',
      previous: anterior,
      currentExamId: 'b',
      current: actual,
    });
    const sitio = comparison.sites.find(
      (item) => item.fdi === 16 && item.side === 'vestibular' && item.index === 0,
    );
    // Había sitio en el actual y no en el anterior: no se puede decir que mejoró.
    expect(sitio?.change).toBe('sin_dato');
  });

  it('el resumen calcula las medias de PS y NIC sobre los sitios comparables', () => {
    const anterior = buildPeriodontalChart();
    const actual = buildPeriodontalChart();
    for (const fdi of [16, 26]) {
      for (const [indice, pd] of [4, 3, 5].entries()) {
        const index = indice as 0 | 1 | 2;
        piece(anterior, fdi).vestibular[index] = site({ pd, gm: 0 });
        piece(actual, fdi).vestibular[index] = site({ pd: pd - 2, gm: 0 });
      }
    }
    // Un sitio medido solo en el actual queda fuera de las medias comparables.
    piece(actual, 36).vestibular[0] = site({ pd: 6, gm: 0, bop: true });

    const comparison = comparePeriodontalCharts({
      previousExamId: 'a',
      previous: anterior,
      currentExamId: 'b',
      current: actual,
    });

    expect(comparison.summary.sitesCompared).toBe(6);
    expect(comparison.summary.improved).toBe(6);
    expect(comparison.summary.stable).toBe(0);
    expect(comparison.summary.meanPdDelta).toBe(-2);
    expect(comparison.summary.meanCalDelta).toBe(-2);
    // 1 sitio con BOP de 7 medidos en el actual (14,3 %) frente a 0 % anterior.
    expect(comparison.summary.bopPercentDelta).toBe(14.3);
  });
});

describe('entradas de la API', () => {
  it('clonar un examen anterior exige decir cuál', () => {
    expect(issuesOf(createPeriodontalExamSchema, { source: 'anterior' })).not.toBeNull();
    expect(
      issuesOf(createPeriodontalExamSchema, {
        source: 'anterior',
        previousExamId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBeNull();
    expect(
      issuesOf(createPeriodontalExamSchema, {
        source: 'odontograma',
        previousExamId: '00000000-0000-4000-8000-000000000001',
      }),
    ).not.toBeNull();
  });

  it('un examen nuevo admite fecha, sesión y notas', () => {
    const parsed = createPeriodontalExamSchema.parse({});
    expect(parsed.source).toBe('odontograma');
    expect(parsed.previousExamId).toBeNull();

    const conFecha = createPeriodontalExamSchema.parse({
      examDate: '2026-10-18',
      notes: '  control de mantenimiento  ',
      sessionId: '00000000-0000-4000-8000-000000000002',
    });
    expect(conFecha.examDate).toBe('2026-10-18');
    expect(conFecha.notes).toBe('control de mantenimiento');
  });

  it('guardar exige revisión, fecha y la boca completa', () => {
    const chart = buildPeriodontalChart();
    expect(issuesOf(savePeriodontalExamSchema, { examDate: '2026-10-18', chart })).not.toBeNull();

    const parsed = savePeriodontalExamSchema.parse({
      revision: 0,
      examDate: '2026-10-18',
      chart,
    });
    expect(parsed.riskFactors).toEqual({ smoking: 'no', diabetes: 'no', hba1c: null });
    expect(parsed.diagnosis).toBeNull();
    expect(parsed.revision).toBe(0);
  });

  it('finalizar solo necesita la revisión vigente', () => {
    expect(issuesOf(finalizePeriodontalExamSchema, {})).not.toBeNull();
    expect(issuesOf(finalizePeriodontalExamSchema, { revision: 3 })).toBeNull();
  });

  it('el listado acota el límite y el estado', () => {
    expect(periodontalExamListQuerySchema.parse({}).limit).toBe(20);
    expect(issuesOf(periodontalExamListQuerySchema, { limit: 0 })).not.toBeNull();
    expect(periodontalExamListQuerySchema.parse({ status: 'finalizado', limit: '5' }).limit).toBe(
      5,
    );
    expect(issuesOf(periodontalExamListQuerySchema, { status: 'otro' })).not.toBeNull();
  });
});
