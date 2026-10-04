import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  clinicalAlerts,
  clinicalSectionIsComplete,
  clinicalSectionSchemaFor,
  clinicalSessionCanClose,
  clinicalSessionContentSchema,
  CLINICAL_SECTION_KEYS,
  CLINICAL_SIGNATURE_SECTIONS,
  MEDICATION_ROUTES,
  missingSignatureSections,
  SESSION_MATERIAL_CODES,
  SESSION_PROCEDURE_CODES,
  type Sex,
} from '@odontocrm/contracts';

import {
  buildPrescription,
  buildRecordSections,
  buildSessionContent,
  TEST_CLINICAL_PROFILES,
  type TestClinicalProfile,
} from './clinical-content.js';

/** Un caso por perfil: lo que el mundo determinista le entrega al contenido clínico. */
interface CasoPerfil {
  profile: TestClinicalProfile;
  sex: Sex;
  age: number;
  /** Motivo de consulta tal como lo escribió el paciente. */
  reason: string;
  /** Alertas que la anamnesis tiene que producir: ni una más ni una menos. */
  alerts: readonly string[];
  teeth: readonly number[];
  sessionNumber: number;
  /** ¿Lleva récipe con este motivo? */
  prescribes: boolean;
}

const CASOS: readonly CasoPerfil[] = [
  {
    profile: 'sano',
    sex: 'M',
    age: 30,
    reason: 'Quiero una limpieza y revisión general',
    alerts: [],
    teeth: [16, 26],
    sessionNumber: 1,
    prescribes: false,
  },
  {
    profile: 'caries_multiple',
    sex: 'F',
    age: 34,
    reason: 'Tengo una caries que me está creciendo',
    alerts: [],
    teeth: [26, 36],
    sessionNumber: 1,
    prescribes: true,
  },
  {
    profile: 'periodontal',
    sex: 'M',
    age: 52,
    reason: 'Tengo las encías inflamadas y me sangran al cepillarme',
    alerts: [],
    teeth: [16, 26],
    sessionNumber: 2,
    prescribes: true,
  },
  {
    profile: 'diabetes',
    sex: 'F',
    age: 45,
    reason: 'Quiero revisarme porque tengo diabetes y me dijeron que debo cuidarme la boca',
    alerts: ['diabetes'],
    teeth: [36, 46],
    sessionNumber: 1,
    prescribes: true,
  },
  {
    profile: 'hipertension',
    sex: 'M',
    age: 58,
    reason: 'Me duele una muela desde hace tres días y no puedo masticar',
    alerts: ['hipertension'],
    teeth: [26],
    sessionNumber: 1,
    prescribes: true,
  },
  {
    profile: 'alergia_penicilina',
    sex: 'F',
    age: 29,
    reason: 'Se me partió un diente comiendo y quiero que me lo revise',
    alerts: ['alergia_penicilina'],
    teeth: [46],
    sessionNumber: 1,
    prescribes: true,
  },
  {
    profile: 'anticoagulado',
    sex: 'M',
    age: 67,
    reason: 'Me falta una muela y quiero saber qué opciones tengo',
    alerts: ['anticoagulante'],
    teeth: [37],
    sessionNumber: 2,
    prescribes: true,
  },
  {
    profile: 'pediatrico',
    sex: 'M',
    age: 8,
    reason: 'Al niño le duele una muela y no ha dormido bien',
    alerts: [],
    teeth: [75],
    sessionNumber: 1,
    prescribes: true,
  },
  {
    profile: 'edentulo_parcial',
    sex: 'F',
    age: 72,
    reason: 'Me molesta el frío en los dientes de adelante',
    alerts: ['hipertension', 'patologico_otro'],
    teeth: [36],
    sessionNumber: 1,
    prescribes: true,
  },
];

const casoDe = (profile: TestClinicalProfile): CasoPerfil => {
  const caso = CASOS.find((item) => item.profile === profile);
  if (caso === undefined) throw new Error(`Falta el caso del perfil ${profile}`);
  return caso;
};

const seccionesDe = (caso: CasoPerfil): Record<string, Record<string, unknown>> =>
  buildRecordSections({
    profile: caso.profile,
    sex: caso.sex,
    age: caso.age,
    reason: caso.reason,
    fullName: 'María Fernanda Pérez',
  });

const alertasDe = (caso: CasoPerfil): string[] =>
  clinicalAlerts(seccionesDe(caso)).map((alert) => alert.code);

const sesionDe = (caso: CasoPerfil) =>
  buildSessionContent({
    profile: caso.profile,
    reason: caso.reason,
    teeth: caso.teeth,
    sessionNumber: caso.sessionNumber,
  });

const recetaDe = (caso: CasoPerfil) =>
  buildPrescription({
    profile: caso.profile,
    reason: caso.reason,
    teeth: caso.teeth,
    medications: [],
  });

/** Nombres y presentaciones del catálogo que siembra la migración 0002 de `clinical`. */
const MIGRACIONES = new URL('../../../../services/clinical/migrations/', import.meta.url);
const CATALOGO_SQL = readdirSync(MIGRACIONES)
  .filter((nombre) => nombre.startsWith('0002_') && nombre.endsWith('.sql'))
  .map((nombre) => readFileSync(new URL(nombre, MIGRACIONES), 'utf8'))
  .join('\n');

/** Los nombres van como texto SQL y las presentaciones, dentro del JSON de `presentations`. */
const enElCatalogo = (valor: string): boolean =>
  CATALOGO_SQL.includes(`'${valor}'`) || CATALOGO_SQL.includes(`"${valor}"`);

const AINE = ['Ibuprofeno', 'Naproxeno', 'Ketoprofeno', 'Diclofenaco', 'Celecoxib', 'Ketorolaco'];

describe('historia clínica del mundo de prueba', () => {
  it('están los nueve perfiles y cada uno tiene su caso', () => {
    expect(TEST_CLINICAL_PROFILES).toHaveLength(9);
    expect(CASOS.map((caso) => caso.profile).sort()).toEqual([...TEST_CLINICAL_PROFILES].sort());
  });

  it('cada perfil escribe las once secciones y todas pasan el esquema de su clave', () => {
    for (const caso of CASOS) {
      const secciones = seccionesDe(caso);
      expect(Object.keys(secciones).sort(), caso.profile).toEqual(
        [...CLINICAL_SECTION_KEYS].sort(),
      );
      for (const key of CLINICAL_SECTION_KEYS) {
        const resultado = clinicalSectionSchemaFor(key).safeParse(secciones[key]);
        expect(resultado.success, `${caso.profile} · ${key}`).toBe(true);
      }
    }
  });

  it('las seis secciones que exige la firma quedan completas', () => {
    for (const caso of CASOS) {
      const secciones = seccionesDe(caso);
      expect(missingSignatureSections(secciones), caso.profile).toEqual([]);
      for (const key of CLINICAL_SIGNATURE_SECTIONS) {
        expect(clinicalSectionIsComplete(key, secciones[key]), `${caso.profile} · ${key}`).toBe(
          true,
        );
      }
    }
  });

  it('identificación, antecedentes, exámenes, consentimiento y evolución también llevan contenido', () => {
    const obligatorias = new Set<string>(CLINICAL_SIGNATURE_SECTIONS);
    const restantes = CLINICAL_SECTION_KEYS.filter((key) => !obligatorias.has(key));
    expect(restantes).toHaveLength(5);
    for (const caso of CASOS) {
      const secciones = seccionesDe(caso);
      for (const key of restantes) {
        expect(clinicalSectionIsComplete(key, secciones[key]), `${caso.profile} · ${key}`).toBe(
          true,
        );
      }
    }
  });

  it('el motivo de consulta cita textualmente lo que escribió el paciente', () => {
    for (const caso of CASOS) {
      const relato = String(seccionesDe(caso)['motivo_consulta']?.['relato']);
      expect(relato, caso.profile).toContain(caso.reason);
    }
  });

  it('un motivo escueto como el del mundo («consulta») sigue valiendo', () => {
    const secciones = buildRecordSections({
      profile: 'sano',
      sex: 'M',
      age: 30,
      reason: 'consulta',
      fullName: 'José Gregorio Rodríguez',
    });
    const relato = String(secciones['motivo_consulta']?.['relato']);
    expect(relato).toContain('consulta');
    expect(
      clinicalSectionSchemaFor('motivo_consulta').safeParse(secciones['motivo_consulta']).success,
    ).toBe(true);
  });

  it('el plan de un paciente pediátrico no propone coronas fijas de adultos', () => {
    const plan = seccionesDe(casoDe('pediatrico'))['plan_tratamiento'];
    const texto = JSON.stringify(plan);
    expect(texto).not.toMatch(/zirconia|metal-porcelana|implante/i);
  });

  it('la misma entrada produce exactamente las mismas secciones', () => {
    for (const caso of CASOS) {
      const primera = seccionesDe(caso);
      const segunda = seccionesDe(caso);
      expect(JSON.stringify(segunda), caso.profile).toBe(JSON.stringify(primera));
      expect(segunda).toEqual(primera);
    }
  });
});

describe('alertas clínicas por perfil', () => {
  it('cada perfil produce exactamente las alertas esperadas', () => {
    for (const caso of CASOS) {
      expect(alertasDe(caso), caso.profile).toEqual([...caso.alerts]);
    }
  });

  it('los perfiles sin antecedentes no disparan ninguna alerta', () => {
    for (const caso of CASOS.filter((item) => item.alerts.length === 0)) {
      expect(alertasDe(caso), caso.profile).toEqual([]);
    }
  });

  it('el adulto mayor explica su «otro» antecedente en el detalle de la alerta', () => {
    const alertas = clinicalAlerts(seccionesDe(casoDe('edentulo_parcial')));
    const otro = alertas.find((alert) => alert.code === 'patologico_otro');
    expect(otro?.detail).not.toBeNull();
    expect(String(otro?.detail)).toMatch(/artrosis|gastritis/i);
  });
});

describe('contenido de la sesión clínica', () => {
  it('la sesión de cada perfil valida y se puede cerrar', () => {
    for (const caso of CASOS) {
      const contenido = sesionDe(caso);
      const resultado = clinicalSessionContentSchema.safeParse(contenido);
      expect(resultado.success, caso.profile).toBe(true);
      expect(clinicalSessionCanClose(contenido), caso.profile).toBe(true);
    }
  });

  it('lo que se guarda es exactamente lo que se construyó (sin campos perdidos)', () => {
    for (const caso of CASOS) {
      const contenido = sesionDe(caso);
      expect(clinicalSessionContentSchema.parse(contenido), caso.profile).toEqual(contenido);
    }
  });

  it('los procedimientos y los materiales salen del catálogo real de la sesión', () => {
    for (const caso of CASOS) {
      const contenido = sesionDe(caso);
      expect(contenido.procedimientos.length, caso.profile).toBeGreaterThan(0);
      for (const procedimiento of contenido.procedimientos) {
        expect(SESSION_PROCEDURE_CODES, caso.profile).toContain(procedimiento.code);
        expect(procedimiento.code).not.toBe('otros');
      }
      for (const material of contenido.materiales) {
        expect(SESSION_MATERIAL_CODES, caso.profile).toContain(material.code);
        expect(material.code).not.toBe('otros');
      }
    }
  });

  it('cada pieza que eligió el mundo aparece en la sesión', () => {
    for (const caso of CASOS) {
      const contenido = sesionDe(caso);
      const tratadas = contenido.procedimientos
        .map((procedimiento) => procedimiento.toothNumber)
        .filter((tooth): tooth is number => tooth !== null);
      for (const tooth of caso.teeth) {
        expect(tratadas, `${caso.profile} · pieza ${String(tooth)}`).toContain(tooth);
      }
      for (const tooth of tratadas) {
        expect(caso.teeth, `${caso.profile} · pieza ${String(tooth)}`).toContain(tooth);
      }
    }
  });

  it('las caras solo se registran con su pieza y no pasan de cinco', () => {
    for (const caso of CASOS) {
      for (const procedimiento of sesionDe(caso).procedimientos) {
        if (procedimiento.surfaces.length > 0) {
          expect(procedimiento.toothNumber, caso.profile).not.toBeNull();
        }
        expect(procedimiento.surfaces.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it('un paciente pediátrico no recibe procedimientos de adulto', () => {
    const contenido = buildSessionContent({
      profile: 'pediatrico',
      reason: 'Al niño le duele una muela y no ha dormido bien',
      teeth: [54, 55],
      sessionNumber: 1,
    });
    const deAdultos = [
      'corona_metal_porcelana',
      'corona_zirconia',
      'implante_quirurgico',
      'carga_implante',
      'protesis_fija',
      'protesis_removible',
      'endodoncia_multirradicular',
    ];
    for (const procedimiento of contenido.procedimientos) {
      expect(deAdultos, `pieza ${String(procedimiento.toothNumber ?? 0)}`).not.toContain(
        procedimiento.code,
      );
    }
    expect(contenido.procedimientos.map((procedimiento) => procedimiento.code)).toContain(
      'obturacion_ionomero',
    );
  });

  it('la sesión 2 continúa el plan y no repite la sesión 1', () => {
    const entrada = {
      profile: 'anticoagulado',
      reason: 'Me falta una muela',
      teeth: [37],
    } as const;
    const primera = buildSessionContent({ ...entrada, sessionNumber: 1 });
    const segunda = buildSessionContent({ ...entrada, sessionNumber: 2 });
    expect(clinicalSessionCanClose(segunda)).toBe(true);
    expect(segunda).not.toEqual(primera);
    expect(segunda.motivo).not.toBe(primera.motivo);
    expect(segunda.procedimientos.map((procedimiento) => procedimiento.code)).not.toEqual(
      primera.procedimientos.map((procedimiento) => procedimiento.code),
    );
  });

  it('la misma entrada produce exactamente la misma sesión', () => {
    for (const caso of CASOS) {
      expect(JSON.stringify(sesionDe(caso)), caso.profile).toBe(JSON.stringify(sesionDe(caso)));
    }
  });

  it('una pieza imposible no llega a la sesión', () => {
    const contenido = buildSessionContent({
      profile: 'periodontal',
      reason: 'Quiero revisar cómo va el tratamiento de las encías',
      teeth: [16, 99],
      sessionNumber: 1,
    });
    const resultado = clinicalSessionContentSchema.safeParse(contenido);
    expect(resultado.success).toBe(true);
    expect(clinicalSessionCanClose(contenido)).toBe(true);
    expect(contenido.procedimientos.some((procedimiento) => procedimiento.toothNumber === 99)).toBe(
      false,
    );
    expect(contenido.procedimientos.some((procedimiento) => procedimiento.toothNumber === 16)).toBe(
      true,
    );
  });

  it('una sesión sin piezas sigue documentando la consulta', () => {
    for (const caso of CASOS) {
      const contenido = buildSessionContent({
        profile: caso.profile,
        reason: caso.reason,
        teeth: [],
        sessionNumber: 1,
      });
      const resultado = clinicalSessionContentSchema.safeParse(contenido);
      expect(resultado.success, caso.profile).toBe(true);
      expect(clinicalSessionCanClose(contenido), caso.profile).toBe(true);
      expect(clinicalSessionContentSchema.parse(contenido), caso.profile).toEqual(contenido);
    }
  });
});

describe('récipes del mundo de prueba', () => {
  it('el catálogo de la migración 0002 se puede leer', () => {
    expect(CATALOGO_SQL).toContain('medications_catalog');
    expect(CATALOGO_SQL).toContain("'Amoxicilina'");
    expect(CATALOGO_SQL).toContain("'Paracetamol'");
  });

  it('los perfiles que no llevan récipe devuelven null', () => {
    expect(recetaDe(casoDe('sano'))).toBeNull();
    const control = buildPrescription({
      profile: 'pediatrico',
      reason: 'Vengo a que le revisen los dientes al niño, es la primera vez',
      teeth: [64, 65],
      medications: [],
    });
    expect(control).toBeNull();
    const sinDolor = buildPrescription({
      profile: 'pediatrico',
      reason: 'Vengo por la limpieza de control',
      teeth: [74],
      medications: [],
    });
    expect(sinDolor).toBeNull();
  });

  it('el niño con dolor sí lleva su analgésico', () => {
    const receta = buildPrescription({
      profile: 'pediatrico',
      reason: 'Al niño le duele una muela y no ha dormido bien',
      teeth: [75],
      medications: [],
    });
    expect(receta).not.toBeNull();
    expect(receta?.items).toHaveLength(1);
    expect(receta?.items[0]?.medicationName).toBe('Paracetamol');
  });

  it('los perfiles que llevan récipe traen al menos un medicamento coherente', () => {
    for (const caso of CASOS) {
      const receta = recetaDe(caso);
      if (!caso.prescribes) {
        expect(receta, caso.profile).toBeNull();
        continue;
      }
      expect(receta, caso.profile).not.toBeNull();
      expect(receta?.items.length ?? 0, caso.profile).toBeGreaterThan(0);
      expect(receta?.generalInstructions.length ?? 0, caso.profile).toBeGreaterThan(20);
    }
  });

  it('los medicamentos y las presentaciones existen en el catálogo de la migración 0002', () => {
    for (const profile of TEST_CLINICAL_PROFILES) {
      const caso = casoDe(profile);
      const receta = buildPrescription({
        profile,
        reason: 'Tengo una infección con pus y me duele mucho',
        teeth: caso.teeth,
        medications: [],
      });
      if (receta === null) continue;
      for (const item of receta.items) {
        expect(enElCatalogo(item.medicationName), `${profile} · ${item.medicationName}`).toBe(true);
        if (item.presentation !== null) {
          expect(enElCatalogo(item.presentation), `${profile} · ${item.presentation}`).toBe(true);
        }
        if (item.route !== null) {
          expect(MEDICATION_ROUTES, `${profile} · ${item.route}`).toContain(item.route);
        }
        expect(item.dose.length).toBeGreaterThan(0);
        expect(item.frequency.length).toBeGreaterThan(0);
      }
    }
  });

  it('el alérgico a la penicilina nunca recibe penicilinas', () => {
    const receta = buildPrescription({
      profile: 'alergia_penicilina',
      reason: 'Tengo una infección con pus y me duele mucho',
      teeth: [46],
      medications: [],
    });
    const nombres = receta?.items.map((item) => item.medicationName) ?? [];
    expect(nombres).toContain('Azitromicina');
    for (const nombre of nombres) {
      expect(nombre).not.toMatch(/amoxicilina|penicilin|clavul/i);
    }
  });

  it('al anticoagulado, al hipertenso y al diabético no se les receta un AINE', () => {
    for (const profile of [
      'anticoagulado',
      'hipertension',
      'diabetes',
      'edentulo_parcial',
    ] as const) {
      const receta = buildPrescription({
        profile,
        reason: 'Me duele una muela desde hace tres días y tengo la encía inflamada',
        teeth: [36],
        medications: [],
      });
      const nombres = receta?.items.map((item) => item.medicationName) ?? [];
      expect(nombres, profile).toContain('Paracetamol');
      for (const nombre of nombres) {
        expect(AINE, profile).not.toContain(nombre);
      }
    }
  });

  it('al niño se le indica una presentación pediátrica con dosis por peso', () => {
    for (const profile of ['pediatrico', 'caries_multiple'] as const) {
      const receta = buildPrescription({
        profile,
        reason: 'Al niño le duele una muela y no puede comer',
        teeth: [54, 55],
        medications: [],
      });
      const item = receta?.items[0];
      expect(item, profile).toBeDefined();
      expect(String(item?.presentation), profile).toMatch(/suspensi|jarabe/i);
      expect(String(item?.dose), profile).toMatch(/peso/i);
    }
  });

  it('el catálogo vivo manda cuando trae presentaciones y vías', () => {
    const receta = buildPrescription({
      profile: 'caries_multiple',
      reason: 'Me duele una muela desde hace tres días',
      teeth: [26],
      medications: [
        { name: 'Ibuprofeno', presentations: ['Tabletas 600 mg'], routes: ['oral'] },
        { name: 'Paracetamol', presentations: ['Tabletas 500 mg'], routes: ['oral'] },
      ],
    });
    const item = receta?.items[0];
    expect(item?.medicationName).toBe('Ibuprofeno');
    expect(item?.presentation).toBe('Tabletas 600 mg');
    expect(item?.route).toBe('oral');
  });

  it('la misma entrada produce exactamente el mismo récipe', () => {
    for (const caso of CASOS) {
      const primera = buildPrescription({
        profile: caso.profile,
        reason: caso.reason,
        teeth: caso.teeth,
        medications: [],
      });
      const segunda = buildPrescription({
        profile: caso.profile,
        reason: caso.reason,
        teeth: caso.teeth,
        medications: [],
      });
      expect(JSON.stringify(segunda), caso.profile).toBe(JSON.stringify(primera));
    }
  });
});

describe('determinismo del contenido clínico', () => {
  it('el módulo no usa azar ni el reloj del sistema', () => {
    const fuente = readFileSync(new URL('./clinical-content.ts', import.meta.url), 'utf8');
    expect(fuente).not.toMatch(/Math\.random|new Date\(|Date\.now/);
  });

  it('el mismo caso produce el mismo contenido en las tres salidas', () => {
    for (const caso of CASOS) {
      const huella = JSON.stringify({
        secciones: seccionesDe(caso),
        sesion: sesionDe(caso),
        receta: recetaDe(caso),
      });
      const otra = JSON.stringify({
        secciones: seccionesDe(caso),
        sesion: sesionDe(caso),
        receta: recetaDe(caso),
      });
      expect(otra, caso.profile).toBe(huella);
    }
  });
});
