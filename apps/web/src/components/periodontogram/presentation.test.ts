import {
  buildPeriodontalChart,
  comparePeriodontalCharts,
  emptyPeriodontalRiskFactors,
  periodontalMetrics,
  type PeriodontalChart,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  calText,
  comparisonKpiItems,
  deltaText,
  examDateLabel,
  examStatusLabel,
  evidenceText,
  faceSiteTexts,
  furcationGradeText,
  furcationLabel,
  gmText,
  gradeLabel,
  kpiItems,
  mobilityLabel,
  numberText,
  percentText,
  riskFactorsText,
  siteAnatomyName,
  siteAriaLabel,
  siteFieldText,
  stageLabel,
  suggestionText,
  toothStateText,
} from './presentation';

/**
 * Pruebas de la capa de presentación: las cifras y los catálogos traducidos que ven
 * la pantalla y el papel. Aquí se comprueba que un sitio sin sondar se lee «—» (no
 * un 0), que el margen lleva su signo y que los nombres anatómicos respetan el
 * cuadrante (MV vs DV), que es la trampa clásica del periodontograma.
 */

/** Boca con una bolsa profunda y sangrado en el 16, para los KPIs. */
const bocaConBolsa = (): PeriodontalChart => {
  const chart = buildPeriodontalChart();
  return chart.map((tooth) =>
    tooth.fdi === 16
      ? {
          ...tooth,
          vestibular: [
            { ...tooth.vestibular[0], pd: 7, gm: -2, bop: true },
            tooth.vestibular[1],
            tooth.vestibular[2],
          ],
          mobility: 2,
        }
      : tooth,
  );
};

describe('cifras clínicas', () => {
  it('un sitio sin sondar se lee «—» y nunca un 0', () => {
    expect(numberText(null)).toBe('—');
    expect(numberText(0)).toBe('0');
    expect(gmText(null)).toBe('—');
    expect(calText({ pd: null, gm: null })).toBe('—');
  });

  it('el margen lleva signo: + es hiperplasia y − es recesión', () => {
    expect(gmText(2)).toBe('+2');
    expect(gmText(-3)).toBe('-3');
    expect(gmText(0)).toBe('0');
  });

  it('el NIC se deriva con MG = 0 cuando no hay margen', () => {
    expect(calText({ pd: 4, gm: null })).toBe('4');
    expect(calText({ pd: 4, gm: -2 })).toBe('6');
    expect(calText({ pd: 2, gm: 3 })).toBe('0');
  });

  it('porcentajes y deltas muestran la unidad y el signo', () => {
    expect(percentText(12.5)).toBe('12.5 %');
    expect(percentText(null)).toBe('—');
    expect(percentText(4, true)).toBe('+4 %');
    expect(deltaText(-2)).toBe('-2 mm');
    expect(deltaText(2)).toBe('+2 mm');
    expect(deltaText(null)).toBe('—');
  });

  it('los milímetros del sitio se formatean según el canal', () => {
    expect(siteFieldText({ pd: 3, gm: -1 }, 'pd')).toBe('3');
    expect(siteFieldText({ pd: 3, gm: -1 }, 'gm')).toBe('-1');
  });

  it('cada uno de los tres sitios de una cara lleva su propio valor', () => {
    const sites = [
      { pd: 6, gm: -3 },
      { pd: null, gm: null },
      { pd: 2, gm: 4 },
    ] as const;
    // El bug del pad: un 6 en DV se pintaba también en V y en MV.
    expect(faceSiteTexts(sites, 'pd')).toEqual(['6', '—', '2']);
    expect(faceSiteTexts(sites, 'gm')).toEqual(['-3', '—', '+4']);
  });
});

describe('catálogos traducidos', () => {
  it('el nombre anatómico respeta el cuadrante (no se invierte MV/DV)', () => {
    // En el 16 (cuadrante 1, dibujado de 18 a 11) el sitio visual izquierdo es el distal.
    expect(siteAnatomyName(16, 'vestibular', 0)).toBe('Distovestibular');
    expect(siteAnatomyName(16, 'vestibular', 2)).toBe('Mesiovestibular');
    // En el 26 (cuadrante 2) se invierte: la izquierda visual es la mesial.
    expect(siteAnatomyName(26, 'vestibular', 0)).toBe('Mesiovestibular');
    expect(siteAnatomyName(26, 'vestibular', 2)).toBe('Distovestibular');
    // En el maxilar la cara interna es el palatino; en la mandíbula, el lingual.
    expect(siteAnatomyName(16, 'lingual', 0)).toBe('Distopalatino');
    expect(siteAnatomyName(16, 'lingual', 2)).toBe('Mesiopalatino');
    expect(siteAnatomyName(46, 'lingual', 0)).toBe('Distolingual');
    expect(siteAnatomyName(46, 'lingual', 2)).toBe('Mesiolingual');
  });

  it('la etiqueta accesible de un sitio nombra pieza, cara y sitio', () => {
    const etiqueta = siteAriaLabel(16, 'vestibular', 0);
    expect(etiqueta).toContain('16');
    expect(etiqueta.toLowerCase()).toContain('vestibular');
    expect(etiqueta.toLowerCase()).toContain('distovestibular');
  });

  it('movilidad, furca y estados tienen texto en español (no la clave)', () => {
    expect(mobilityLabel(null)).toBe('No evaluada');
    expect(mobilityLabel(2)).toBe('M2');
    expect(furcationLabel(null)).toBe('—');
    expect(furcationLabel(3)).toBe('III');
    expect(furcationGradeText(1)).toBe('I');
    expect(examStatusLabel('borrador')).toBe('Borrador');
    expect(stageLabel(3)).toBe('Estadio III (severo)');
    expect(gradeLabel('C')).toBe('Grado C (progresión rápida)');
    expect(examDateLabel('2026-10-18')).toBe('18/10/2026');
  });

  it('las piezas se describen por su estado', () => {
    const chart = buildPeriodontalChart({ missing: [18], implants: [16] });
    const [primera, tercera] = [chart[0], chart[2]];
    expect(primera && toothStateText(primera)).toBe('Ausente');
    expect(tercera && toothStateText(tercera)).toBe('Implante');
    expect(toothStateText(chart[1]!)).toBe('Presente');
  });
});

describe('indicadores del panel y del papel', () => {
  it('la boca vacía no tiene índices: los valores quedan en guion', () => {
    const items = kpiItems(periodontalMetrics(buildPeriodontalChart()));
    const bop = items.find((item) => item.key === 'bop');
    expect(bop?.value).toBe('—');
    expect(items).toHaveLength(17);
    // Sin sitios medidos no se pinta un 0 % de sangrado.
    expect(bop?.tone).toBe('neutral');
  });

  it('una bolsa de 7 mm marca los umbrales de bolsa y de NIC', () => {
    const items = kpiItems(periodontalMetrics(bocaConBolsa()));
    const bolsas6 = items.find((item) => item.key === 'bolsas6');
    const nic = items.find((item) => item.key === 'nicInterproximal');
    expect(bolsas6?.tone).toBe('danger');
    expect(bolsas6?.value).toBe('1');
    expect(nic?.value).toBe('9 mm');
  });

  it('el resumen de la comparación usa las mismas tarjetas', () => {
    const comparison = comparePeriodontalCharts({
      previousExamId: 'a',
      previous: buildPeriodontalChart(),
      currentExamId: 'b',
      current: bocaConBolsa(),
    });
    const items = comparisonKpiItems(comparison.summary);
    expect(items.map((item) => item.key)).toContain('deltaPs');
    expect(items.find((item) => item.key === 'bolsasNuevas')?.value).toBe('1');
  });
});

describe('textos de la sugerencia y del riesgo', () => {
  it('la sugerencia enumera estadio, grado y evidencias', () => {
    const texto = suggestionText({
      stage: 3,
      grade: 'B',
      evidence: [{ code: 'bolsa_profunda', value: 7 }],
    });
    expect(texto).toContain('Estadio III');
    expect(texto).toContain('Grado B');
    expect(evidenceText({ code: 'bolsa_profunda', value: 7 })).toContain('7');
  });

  it('los factores de riesgo se leen en una línea', () => {
    const texto = riskFactorsText({
      ...emptyPeriodontalRiskFactors(),
      smoking: 'menos10',
      diabetes: 'controlada',
      hba1c: 6.8,
    });
    expect(texto).toContain('Menos de 10 cigarrillos');
    expect(texto).toContain('Diabetes controlada');
    expect(texto).toContain('6.8');
  });
});
