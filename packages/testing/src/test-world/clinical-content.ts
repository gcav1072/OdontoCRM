import {
  emptySessionExam,
  emptySessionVitals,
  isPrimaryTooth,
  isToothNumber,
  MEDICATION_ROUTES,
  positionOfTooth,
  procedureLabel,
  type ClinicalSectionKey,
  type ClinicalSessionContent,
  type MedicationRoute,
  type SessionMaterial,
  type SessionMaterialCode,
  type SessionProcedure,
  type SessionProcedureCode,
  type Sex,
  type ToothSurface,
} from '@odontocrm/contracts';

/**
 * Contenido clínico del mundo de prueba (Fase 10, ADR 0020).
 *
 * El mundo determinista decide **quién** es cada paciente ficticio —perfil, edad y
 * sexo— y este módulo decide **qué se escribió** en su historia clínica y en sus
 * sesiones: nueve perfiles (sano, caries múltiple, periodontal, diabético,
 * hipertenso, alérgico a la penicilina, anticoagulado, pediátrico y edéntulo
 * parcial) con textos en español de Venezuela que un odontólogo podría leer sin
 * fruncir el ceño.
 *
 * Tres reglas mandan aquí:
 *
 * 1. **Todo pasa por los contratos.** Las secciones usan las claves exactas de
 *    `clinicalSectionSchemaFor` (varios esquemas son `.strict()`), las seis
 *    secciones que exige la firma quedan completas y las alertas se derivan de la
 *    anamnesis tal como las lee `clinicalAlerts`: la alergia a la penicilina, el
 *    anticoagulante, la diabetes y la hipertensión tienen que salir solas.
 * 2. **Nada de azar ni de reloj.** La variación sale del perfil, del número de
 *    sesión, de las piezas y del motivo; la misma entrada produce exactamente el
 *    mismo contenido, que es lo que sostiene el `seed:verify` del modo test.
 * 3. **Coherencia clínica.** Un niño no lleva corona de porcelana, al alérgico a
 *    la penicilina no se le receta amoxicilina y al anticoagulado no se le da un
 *    antiinflamatorio: los medicamentos salen del catálogo de la migración 0002 y
 *    los procedimientos y materiales, del catálogo de la sesión clínica.
 */

/* ── Perfiles ──────────────────────────────────────────────────────────────── */

/** Perfiles clínicos que reparte el mundo determinista. */
export const TEST_CLINICAL_PROFILES = [
  'sano',
  'caries_multiple',
  'periodontal',
  'diabetes',
  'hipertension',
  'alergia_penicilina',
  'anticoagulado',
  'pediatrico',
  'edentulo_parcial',
] as const;

export type TestClinicalProfile = (typeof TEST_CLINICAL_PROFILES)[number];

/* ── Ayudantes de redacción ────────────────────────────────────────────────── */

type Region = 'normal' | 'alterado' | 'no_evaluado';
type Oclusion =
  'normal' | 'apinamiento' | 'mordida_abierta' | 'mordida_cruzada' | 'sobremordida' | 'sin_dato';
type Higiene = 'buena' | 'regular' | 'deficiente';
type SaludBucal = 'buena' | 'regular' | 'deficiente' | 'sin_dato';
type Prioridad = 'alta' | 'media' | 'baja';
type FrecuenciaVisitas = 'primera_vez' | 'semestral' | 'anual' | 'cuando_molesta' | 'nunca';
type Cepillado = 'una_vez' | 'dos_veces' | 'tres_o_mas' | 'esporadico';

/** Selección de un catálogo tipificado: códigos + texto libre para «otros». */
type Casillas = { items: string[]; otros: string | null };

const casillas = (items: readonly string[] = [], otros: string | null = null): Casillas => ({
  items: [...items],
  otros,
});

type Wording = {
  /** «el paciente», «la paciente», «el niño» o «la niña», según edad y sexo. */
  sujeto: string;
  /** Terminación de concordancia para los adjetivos («remitid» + o/a). */
  oa: 'o' | 'a';
  pediatrico: boolean;
  adultoMayor: boolean;
};

const wordingFor = (sex: Sex, age: number): Wording => {
  const oa: 'o' | 'a' = sex === 'F' ? 'a' : 'o';
  const pediatrico = age < 18;
  const femenino = sex === 'F';
  const sujeto = pediatrico
    ? femenino
      ? 'la niña'
      : sex === 'M'
        ? 'el niño'
        : 'el paciente'
    : femenino
      ? 'la paciente'
      : 'el paciente';
  return { sujeto, oa, pediatrico, adultoMayor: age >= 65 };
};

const capitalizar = (texto: string): string =>
  texto.length === 0 ? texto : `${texto.slice(0, 1).toUpperCase()}${texto.slice(1)}`;

/** Recorta un texto libre al tope del contrato: una razón larga no puede romper el guardado. */
const limitar = (texto: string, max: number): string =>
  texto.length <= max ? texto : `${texto.slice(0, max - 1).trimEnd()}…`;

/** Piezas en lenguaje natural: «la pieza 26» o «las piezas 16, 26 y 36». */
const piezasTexto = (teeth: readonly number[]): string => {
  const lista = [...teeth];
  const primera = lista[0];
  if (primera === undefined) return 'las piezas afectadas';
  if (lista.length === 1) return `la pieza ${String(primera)}`;
  const ultima = lista[lista.length - 1];
  return `las piezas ${lista.slice(0, -1).join(', ')} y ${String(ultima)}`;
};

/** Profundidad de sondaje por pieza, derivada del orden: siempre la misma entrada, el mismo texto. */
const sondajeTexto = (teeth: readonly number[]): string | null =>
  teeth.length === 0
    ? null
    : teeth.map((tooth, index) => `${String(tooth)}: ${String(3 + (index % 3))} mm`).join(', ');

/* ── Historia clínica por perfil ───────────────────────────────────────────── */

type PlanItem = {
  descripcion: string;
  prioridad: Prioridad;
  pieza: string | null;
  presupuesto: number | null;
};

type RecordContent = {
  ocupacion: string;
  /** Lectura clínica que acompaña al relato textual del paciente. */
  lectura: string;
  tiempoEvolucion: string | null;
  anamnesis: {
    sinAntecedentes: boolean;
    alergias: Casillas;
    patologicos: Casillas;
    medicamentos: Casillas;
    cirugias: Casillas;
    familiares: Casillas;
    habitos: Casillas;
    observaciones: string | null;
  };
  antecedentes: {
    tratamientos: Casillas;
    reaccionesAdversas: Casillas;
    experiencias: Casillas;
    frecuenciaVisitas: FrecuenciaVisitas;
    ultimaConsulta: string | null;
    higieneCepillado: Cepillado;
    usaHiloDental: boolean | null;
    tratamientoEnCurso: string | null;
    observaciones: string | null;
  };
  extraoral: {
    tejidosBlandos: Region;
    ganglios: Region;
    atm: Region;
    musculatura: Region;
    hallazgos: string;
    observaciones: string | null;
  };
  intraoral: {
    tejidosBlandos: Region;
    encias: Region;
    sondaje: string | null;
    oclusion: Oclusion;
    higiene: Higiene;
    hallazgos: string;
    observaciones: string | null;
  };
  estudios: { seleccion: Casillas; observaciones: string | null };
  diagnostico: {
    principal: string;
    secundarios: string | null;
    porPieza: string | null;
    saludBucalGeneral: SaludBucal;
    observaciones: string | null;
  };
  plan: {
    procedimientos: PlanItem[];
    alternativas: string;
    aceptacionPaciente: boolean;
    observaciones: string | null;
  };
  consentimiento: {
    riesgosInformados: string;
    alternativasInformadas: string;
    observaciones: string | null;
  };
  evolucion: { resumen: string; observaciones: string | null };
};

type RecordContext = { age: number; wording: Wording };

const planItem = (
  descripcion: string,
  prioridad: Prioridad,
  pieza: string | null = null,
): PlanItem => ({ descripcion, prioridad, pieza, presupuesto: null });

/**
 * Contenido de la historia por perfil. Cada perfil es una función porque el texto
 * depende de la edad (dentición temporal o permanente, adulto mayor) y del sexo
 * (concordancia), que es lo que evita historias clínicas que suenan a plantilla.
 */
const RECORD_BUILDERS: Readonly<
  Record<TestClinicalProfile, (context: RecordContext) => RecordContent>
> = {
  sano: () => ({
    ocupacion: 'Comerciante',
    lectura: 'Acude a consulta de rutina; no refiere dolor, sangrado ni molestias al masticar.',
    tiempoEvolucion: null,
    anamnesis: {
      sinAntecedentes: true,
      alergias: casillas(),
      patologicos: casillas(),
      medicamentos: casillas(),
      cirugias: casillas(),
      familiares: casillas(),
      habitos: casillas(),
      observaciones:
        'Sin alergias conocidas ni antecedentes patológicos referidos. No usa medicamentos de forma continua y niega hábitos tabáquicos o alcohólicos.',
    },
    antecedentes: {
      tratamientos: casillas(),
      reaccionesAdversas: casillas(['ninguna']),
      experiencias: casillas(['ninguna']),
      frecuenciaVisitas: 'anual',
      ultimaConsulta: null,
      higieneCepillado: 'dos_veces',
      usaHiloDental: true,
      tratamientoEnCurso: null,
      observaciones:
        'Refiere cepillado después de cada comida y uso de hilo dental. No precisa la fecha de su última consulta odontológica.',
    },
    extraoral: {
      tejidosBlandos: 'normal',
      ganglios: 'normal',
      atm: 'normal',
      musculatura: 'normal',
      hallazgos:
        'Rostro simétrico, sin lesiones cutáneas. Ganglios cervicales no palpables. ATM sin ruidos ni dolor a la palpación. Musculatura masticatoria normotónica.',
      observaciones: null,
    },
    intraoral: {
      tejidosBlandos: 'normal',
      encias: 'normal',
      sondaje: 'Sondaje de 2 mm generalizado, sin sangrado',
      oclusion: 'normal',
      higiene: 'buena',
      hallazgos:
        'Mucosa oral húmeda y rosada, sin lesiones. Dentición permanente completa, sin caries activas ni restauraciones deficientes.',
      observaciones: null,
    },
    estudios: {
      seleccion: casillas(['radiografia_panoramica']),
      observaciones:
        'Radiografía panorámica de control: sin lesiones periapicales ni pérdida ósea horizontal.',
    },
    diagnostico: {
      principal: 'Paciente en buen estado de salud bucal, sin lesiones activas',
      secundarios: null,
      porPieza: null,
      saludBucalGeneral: 'buena',
      observaciones: 'Se indica control semestral y refuerzo de la técnica de higiene oral.',
    },
    plan: {
      procedimientos: [planItem(`${procedureLabel('profilaxis')} y control semestral`, 'media')],
      alternativas:
        'No se requieren tratamientos adicionales por ahora; se mantiene el control preventivo.',
      aceptacionPaciente: true,
      observaciones: 'Se refuerza la importancia del control periódico.',
    },
    consentimiento: {
      riesgosInformados:
        'Se informa que el examen clínico y la profilaxis no implican riesgos significativos; pueden aparecer molestias leves y transitorias en las encías.',
      alternativasInformadas:
        'Se explica que la alternativa es mantener el control periódico y la higiene diaria en casa; no se propone ningún tratamiento invasivo.',
      observaciones: null,
    },
    evolucion: {
      resumen:
        'Se completa la evaluación clínica de rutina, se realiza la profilaxis y se refuerzan las medidas preventivas.',
      observaciones: 'Paciente sin molestias al finalizar la consulta.',
    },
  }),

  caries_multiple: ({ age, wording }) => {
    const temporal = age <= 12;
    return {
      ocupacion: 'Asistente administrativo',
      lectura: temporal
        ? 'El representante refiere molestias al comer dulces y sensibilidad al frío en varias piezas.'
        : 'Refiere sensibilidad al frío y dolor breve al masticar en varias piezas.',
      tiempoEvolucion: temporal ? '3 semanas' : '1 mes',
      anamnesis: {
        sinAntecedentes: false,
        alergias: casillas(),
        patologicos: casillas(),
        medicamentos: casillas(),
        cirugias: casillas(['amigdalectomia']),
        familiares: casillas(temporal ? ['malformacion_dental'] : ['diabetes']),
        habitos: casillas(temporal ? ['onicofagia'] : ['bruxismo']),
        observaciones: temporal
          ? `Sin alergias conocidas. El representante refiere que ${wording.sujeto} consume jugos y golosinas entre comidas y que el cepillado se supervisa una vez al día.`
          : 'Sin alergias conocidas ni antecedentes patológicos. Refiere consumo frecuente de bebidas azucaradas y cepillado dos veces al día.',
      },
      antecedentes: {
        tratamientos: casillas(['restauracion']),
        reaccionesAdversas: casillas(['ninguna']),
        experiencias: casillas(temporal ? ['ansiedad'] : ['ninguna']),
        frecuenciaVisitas: 'cuando_molesta',
        ultimaConsulta: null,
        higieneCepillado: temporal ? 'una_vez' : 'dos_veces',
        usaHiloDental: false,
        tratamientoEnCurso: null,
        observaciones: temporal
          ? 'El representante refiere restauraciones previas en dientes temporales y que el menor acude al odontólogo solo cuando le molesta.'
          : 'Refiere restauraciones previas y visita al odontólogo solo cuando tiene molestias.',
      },
      extraoral: {
        tejidosBlandos: 'normal',
        ganglios: 'normal',
        atm: 'normal',
        musculatura: 'normal',
        hallazgos: temporal
          ? 'Rostro simétrico; ganglios cervicales no palpables; ATM sin ruidos; musculatura normotónica. Se observa respiración bucal ocasional.'
          : 'Rostro simétrico, sin adenopatías; ATM sin ruidos ni dolor; musculatura masticatoria normotónica.',
        observaciones: null,
      },
      intraoral: {
        tejidosBlandos: 'normal',
        encias: 'alterado',
        sondaje: temporal ? null : 'Sondaje de 2 a 3 mm, sin pérdida de inserción',
        oclusion: temporal ? 'normal' : 'apinamiento',
        higiene: 'deficiente',
        hallazgos: temporal
          ? 'Molares temporales con lesiones de caries oclusales y proximales; esmalte con hipomineralización en incisivos superiores; gingivitis marginal leve.'
          : 'Lesiones de caries oclusales y proximales en varios sectores; restauraciones con márgenes desadaptados; gingivitis marginal.',
        observaciones: temporal
          ? 'Se indica cepillado supervisado y control de la dieta.'
          : 'Se refuerza la técnica de cepillado y el uso de hilo dental.',
      },
      estudios: {
        seleccion: casillas(
          temporal
            ? ['aleta_mordida', 'fotografias_clinicas']
            : ['aleta_mordida', 'radiografia_periapical'],
        ),
        observaciones:
          'Las aletas de mordida muestran lesiones proximales que no se ven clínicamente, sin compromiso pulpar aparente.',
      },
      diagnostico: {
        principal: temporal
          ? 'Caries de la infancia temprana en dentición temporal'
          : 'Caries dental activa en dentición permanente (lesiones oclusales y proximales)',
        secundarios: 'Gingivitis asociada a placa bacteriana',
        porPieza: null,
        saludBucalGeneral: 'deficiente',
        observaciones: temporal
          ? 'Riesgo cariogénico alto: se refuerza la higiene supervisada y el control de la dieta.'
          : 'Riesgo cariogénico alto: se indica reducir bebidas azucaradas y mejorar la higiene.',
      },
      plan: {
        procedimientos: [
          planItem(
            `${procedureLabel(temporal ? 'obturacion_ionomero' : 'obturacion_resina')} en las piezas afectadas`,
            'alta',
          ),
          planItem(procedureLabel('profilaxis'), 'media'),
          planItem(procedureLabel('aplicacion_fluor'), 'media'),
          planItem(procedureLabel('control_postoperatorio'), 'baja'),
        ],
        alternativas:
          'Si alguna lesión compromete la pulpa se valorará tratamiento de conducto o exodoncia de la pieza.',
        aceptacionPaciente: true,
        observaciones:
          'Se explica el plan por sesiones y el cuidado posterior de las restauraciones.',
      },
      consentimiento: {
        riesgosInformados:
          'Se informa que las restauraciones pueden producir sensibilidad transitoria y que, si la lesión alcanza la pulpa, puede requerir un tratamiento adicional.',
        alternativasInformadas:
          'Se explica la alternativa de retirar el tejido afectado sin restaurar de inmediato y la de extraer las piezas no recuperables.',
        observaciones: temporal
          ? 'El representante comprende y acepta el plan; se entrega indicación por escrito.'
          : 'El paciente comprende y acepta el plan de tratamiento.',
      },
      evolucion: {
        resumen: temporal
          ? 'Se evalúa al menor, se confirma el plan restaurador por sesiones y se refuerzan las medidas de higiene.'
          : 'Se evalúa el estado de las restauraciones y las lesiones activas, y se organiza el plan restaurador por sesiones.',
        observaciones: 'Se cita para continuar el plan de tratamiento.',
      },
    };
  },

  periodontal: ({ age }) => {
    const adolescente = age < 18;
    return {
      ocupacion: 'Docente',
      lectura: adolescente
        ? 'Refiere sangrado de las encías al cepillarse y mal aliento ocasional.'
        : 'Refiere sangrado gingival al cepillarse, movilidad leve y mal aliento.',
      tiempoEvolucion: adolescente ? '2 meses' : '8 meses',
      anamnesis: {
        sinAntecedentes: false,
        alergias: casillas(),
        patologicos: casillas(),
        medicamentos: casillas(),
        cirugias: casillas(),
        familiares: casillas(['diabetes']),
        habitos: casillas(adolescente ? ['onicofagia'] : ['tabaquismo', 'bruxismo']),
        observaciones: adolescente
          ? 'Sin alergias conocidas ni antecedentes patológicos. Refiere cepillado rápido y sin hilo dental.'
          : 'Sin alergias conocidas ni antecedentes patológicos. Fuma desde hace varios años y refiere apretamiento dentario nocturno.',
      },
      antecedentes: {
        tratamientos: casillas(adolescente ? ['ortodoncia'] : ['restauracion', 'endodoncia']),
        reaccionesAdversas: casillas(['ninguna']),
        experiencias: casillas(['ninguna']),
        frecuenciaVisitas: 'cuando_molesta',
        ultimaConsulta: null,
        higieneCepillado: 'dos_veces',
        usaHiloDental: false,
        tratamientoEnCurso: adolescente ? null : 'Detartrajes periódicos en otro centro',
        observaciones: adolescente
          ? 'Usó aparatos de ortodoncia hasta hace un año; refiere dificultad para la higiene.'
          : 'Refiere detartrajes esporádicos y sangrado persistente entre visitas.',
      },
      extraoral: {
        tejidosBlandos: 'normal',
        ganglios: 'normal',
        atm: 'alterado',
        musculatura: 'normal',
        hallazgos: adolescente
          ? 'Rostro simétrico, sin adenopatías; ATM con leve chasquido a la apertura, sin dolor.'
          : 'Rostro simétrico; ganglios submandibulares no palpables; ATM con chasquido y fatiga muscular referida al despertar.',
        observaciones: null,
      },
      intraoral: {
        tejidosBlandos: 'normal',
        encias: 'alterado',
        sondaje: adolescente
          ? 'Sondaje de 2 a 3 mm generalizado, con sangrado al sondaje'
          : 'Sondaje de 3 a 5 mm en sectores posteriores, con sangrado y recesión leve',
        oclusion: 'apinamiento',
        higiene: 'deficiente',
        hallazgos: adolescente
          ? 'Encías eritematosas y edematizadas con sangrado al sondaje; cálculo supragingival en sectores anteroinferiores.'
          : 'Cálculo supragingival y subgingival en sectores posteriores; encías eritematosas; movilidad leve en molares; sin lesiones de mucosa.',
        observaciones: 'Se instruye técnica de cepillado de Bass modificada.',
      },
      estudios: {
        seleccion: casillas(['radiografia_panoramica']),
        observaciones: adolescente
          ? 'No se observa pérdida ósea en la radiografía panorámica.'
          : 'Radiografía panorámica con pérdida ósea horizontal leve en sectores posteriores.',
      },
      diagnostico: {
        principal: adolescente
          ? 'Gingivitis asociada a placa bacteriana, generalizada'
          : 'Periodontitis crónica generalizada leve a moderada',
        secundarios: adolescente ? 'Apiñamiento dentario leve' : 'Bruxismo y apiñamiento dentario',
        porPieza: null,
        saludBucalGeneral: 'regular',
        observaciones: adolescente
          ? 'El cuadro es reversible con higiene y control periódico.'
          : 'Se explican los factores de riesgo (tabaquismo) y la necesidad de control periódico.',
      },
      plan: {
        procedimientos: [
          planItem(procedureLabel('detartraje'), 'alta'),
          planItem(procedureLabel('profilaxis'), 'media'),
          planItem(procedureLabel('control_postoperatorio'), 'media'),
        ],
        alternativas:
          'Si el sangrado y la profundidad de sondaje persisten se indicará antibioticoterapia y evaluación periodontal especializada.',
        aceptacionPaciente: true,
        observaciones: 'Se instruye en cepillado de Bass modificado y uso de hilo dental diario.',
      },
      consentimiento: {
        riesgosInformados:
          'Se informa que el detartraje puede producir sensibilidad transitoria, sangrado leve y retracción gingival; sin tratamiento, la pérdida ósea progresa.',
        alternativasInformadas:
          'Se explica la alternativa de mantener solo control de placa en casa, con menor control de la enfermedad.',
        observaciones: 'Se entrega por escrito la técnica de higiene indicada.',
      },
      evolucion: {
        resumen:
          'Se realiza la evaluación periodontal, se explica el diagnóstico y se inicia el plan de detartrajes con instrucciones de higiene.',
        observaciones: 'Se refuerza la suspensión del tabaquismo.',
      },
    };
  },

  diabetes: ({ age }) => {
    const anios = age < 45 ? 5 : 12;
    return {
      ocupacion: 'Contadora',
      lectura:
        'Acude por indicación médica para cuidar su salud bucal; refiere sangrado gingival ocasional.',
      tiempoEvolucion: '1 año',
      anamnesis: {
        sinAntecedentes: false,
        alergias: casillas(),
        patologicos: casillas(['diabetes']),
        medicamentos: casillas(['antidiabeticos']),
        cirugias: casillas(),
        familiares: casillas(['diabetes']),
        habitos: casillas(['bruxismo']),
        observaciones: `Diabetes mellitus tipo 2 diagnosticada hace ${String(anios)} años, en tratamiento con metformina. Refiere glicemias entre 110 y 140 mg/dl y control médico cada tres meses.`,
      },
      antecedentes: {
        tratamientos: casillas(['restauracion', 'extraccion']),
        reaccionesAdversas: casillas(['ninguna']),
        experiencias: casillas(['ninguna']),
        frecuenciaVisitas: 'semestral',
        ultimaConsulta: null,
        higieneCepillado: 'dos_veces',
        usaHiloDental: true,
        tratamientoEnCurso: null,
        observaciones:
          'Refiere restauraciones previas y controles semestrales. Niega sangrado espontáneo.',
      },
      extraoral: {
        tejidosBlandos: 'normal',
        ganglios: 'normal',
        atm: 'normal',
        musculatura: 'normal',
        hallazgos:
          'Rostro simétrico, sin adenopatías. Mucosa labial ligeramente seca. ATM sin ruidos ni dolor.',
        observaciones: null,
      },
      intraoral: {
        tejidosBlandos: 'alterado',
        encias: 'alterado',
        sondaje: 'Sondaje de 3 a 4 mm en sectores posteriores, con sangrado',
        oclusion: 'normal',
        higiene: 'regular',
        hallazgos:
          'Encías con inflamación marginal y cálculo supragingival; xerostomía leve; restauraciones con márgenes desadaptados en sectores posteriores.',
        observaciones:
          'Se recomienda aumentar la ingesta de agua y el cepillado después de cada comida.',
      },
      estudios: {
        seleccion: casillas(['radiografia_panoramica', 'analisis_laboratorio']),
        observaciones:
          'Se solicitan glicemia en ayunas y hemoglobina glicosilada recientes; la panorámica muestra pérdida ósea horizontal leve.',
      },
      diagnostico: {
        principal: 'Enfermedad periodontal asociada a diabetes mellitus tipo 2',
        secundarios: 'Caries dental activa en piezas posteriores',
        porPieza: null,
        saludBucalGeneral: 'regular',
        observaciones:
          'El control metabólico condiciona la cicatrización y el pronóstico periodontal.',
      },
      plan: {
        procedimientos: [
          planItem(procedureLabel('detartraje'), 'alta'),
          planItem(`${procedureLabel('obturacion_resina')} en las piezas afectadas`, 'alta'),
          planItem(procedureLabel('control_postoperatorio'), 'media'),
        ],
        alternativas:
          'Si la glicemia no está controlada se postergarán los procedimientos quirúrgicos hasta la evaluación médica.',
        aceptacionPaciente: true,
        observaciones:
          'Se coordina con su médico tratante y se indica control periodontal cada tres meses.',
      },
      consentimiento: {
        riesgosInformados:
          'Se informa que la diabetes aumenta el riesgo de infección, sangrado y cicatrización lenta, y que el control de la glicemia es parte del tratamiento.',
        alternativasInformadas:
          'Se explica la alternativa de limitar el tratamiento a la urgencia y posponer el resto hasta mejorar el control metabólico.',
        observaciones: 'Se entregan recomendaciones de higiene adaptadas al paciente diabético.',
      },
      evolucion: {
        resumen:
          'Se evalúa el estado periodontal y las restauraciones, se refuerza el control metabólico y se inicia el plan por sesiones.',
        observaciones: 'Se solicita reporte médico actualizado.',
      },
    };
  },

  hipertension: ({ age }) => ({
    ocupacion: 'Chofer',
    lectura:
      'Refiere molestias al masticar y sensibilidad al frío en piezas posteriores; refiere tomar su medicación.',
    tiempoEvolucion: age >= 40 ? '2 meses' : '3 semanas',
    anamnesis: {
      sinAntecedentes: false,
      alergias: casillas(),
      patologicos: casillas(['hipertension']),
      medicamentos: casillas(['antihipertensivos']),
      cirugias: casillas(),
      familiares: casillas(['hipertension', 'cardiopatia']),
      habitos: casillas(['bruxismo']),
      observaciones:
        'Hipertensión arterial diagnosticada hace varios años, controlada con losartán. Refiere cifras habituales alrededor de 130/85 mmHg y control médico cada seis meses.',
    },
    antecedentes: {
      tratamientos: casillas(['restauracion']),
      reaccionesAdversas: casillas(['ninguna']),
      experiencias: casillas(['ninguna']),
      frecuenciaVisitas: 'anual',
      ultimaConsulta: null,
      higieneCepillado: 'dos_veces',
      usaHiloDental: false,
      tratamientoEnCurso: null,
      observaciones: 'Refiere restauraciones antiguas de amalgama y controles irregulares.',
    },
    extraoral: {
      tejidosBlandos: 'normal',
      ganglios: 'normal',
      atm: 'normal',
      musculatura: 'normal',
      hallazgos: 'Rostro simétrico, sin adenopatías; ATM sin ruidos ni dolor a la palpación.',
      observaciones: 'Se registra la tensión arterial antes de iniciar el procedimiento.',
    },
    intraoral: {
      tejidosBlandos: 'normal',
      encias: 'alterado',
      sondaje: 'Sondaje de 2 a 3 mm, sin sangrado',
      oclusion: 'normal',
      higiene: 'regular',
      hallazgos:
        'Gingivitis marginal leve; cálculo supragingival; restauraciones de amalgama con márgenes desadaptados y caries recurrente en sectores posteriores.',
      observaciones: null,
    },
    estudios: {
      seleccion: casillas(['radiografia_panoramica', 'aleta_mordida']),
      observaciones:
        'La panorámica muestra restauraciones en molares y pérdida ósea horizontal leve; las aletas confirman caries recurrente.',
    },
    diagnostico: {
      principal: 'Caries dental recurrente en piezas posteriores; paciente hipertenso controlado',
      secundarios: 'Gingivitis leve asociada a placa bacteriana',
      porPieza: null,
      saludBucalGeneral: 'regular',
      observaciones:
        'Se evita el uso de antiinflamatorios no esteroideos por la hipertensión; se indica analgesia con paracetamol.',
    },
    plan: {
      procedimientos: [
        planItem(
          `Reemplazo de las restauraciones desadaptadas por ${procedureLabel('obturacion_resina').toLowerCase()}`,
          'alta',
        ),
        planItem(procedureLabel('detartraje'), 'media'),
        planItem(procedureLabel('control_postoperatorio'), 'baja'),
      ],
      alternativas:
        'Se plantea la alternativa de obturaciones con amalgama si el aislamiento del campo no es adecuado.',
      aceptacionPaciente: true,
      observaciones: 'Se controla la tensión arterial antes y después de la anestesia.',
    },
    consentimiento: {
      riesgosInformados:
        'Se informa que la anestesia con vasoconstrictor exige control de la tensión arterial y que puede haber sensibilidad postoperatoria.',
      alternativasInformadas:
        'Se explica la alternativa de tratamiento sin vasoconstrictor y de posponer los procedimientos hasta controlar la tensión.',
      observaciones: null,
    },
    evolucion: {
      resumen:
        'Se registra la tensión arterial, se evalúan las restauraciones y se inicia el plan de reemplazo por sesiones.',
      observaciones: 'Paciente estable durante la consulta.',
    },
  }),

  alergia_penicilina: ({ wording }) => ({
    ocupacion: 'Enfermera',
    lectura:
      'Refiere dolor localizado y aumento de volumen en una pieza posterior; refiere alergia a la penicilina.',
    tiempoEvolucion: '10 días',
    anamnesis: {
      sinAntecedentes: false,
      alergias: casillas(['penicilina'], 'Erupción cutánea generalizada hace 10 años'),
      patologicos: casillas(),
      medicamentos: casillas(),
      cirugias: casillas(['extraccion_dental']),
      familiares: casillas(),
      habitos: casillas(),
      observaciones:
        'Refiere reacción alérgica a la penicilina documentada (erupción cutánea generalizada). No usa medicamentos de forma continua. Resto de antecedentes sin particularidades.',
    },
    antecedentes: {
      tratamientos: casillas(['restauracion', 'extraccion']),
      reaccionesAdversas: casillas(['ninguna']),
      experiencias: casillas(['ansiedad']),
      frecuenciaVisitas: 'cuando_molesta',
      ultimaConsulta: null,
      higieneCepillado: 'dos_veces',
      usaHiloDental: false,
      tratamientoEnCurso: null,
      observaciones:
        'Refiere extracciones previas sin complicaciones y ansiedad ante los procedimientos.',
    },
    extraoral: {
      tejidosBlandos: 'normal',
      ganglios: 'alterado',
      atm: 'normal',
      musculatura: 'normal',
      hallazgos:
        'Aumento de volumen leve en la región submandibular derecha, doloroso a la palpación; adenopatía móvil de aproximadamente 1 cm.',
      observaciones: null,
    },
    intraoral: {
      tejidosBlandos: 'alterado',
      encias: 'alterado',
      sondaje: null,
      oclusion: 'normal',
      higiene: 'regular',
      hallazgos:
        'Pieza posterior con destrucción coronaria y restos radiculares; encía adyacente eritematosa con supuración al sondaje; sin lesiones en el resto de la mucosa.',
      observaciones: 'Se indica enjuague con solución fisiológica tibia hasta la exodoncia.',
    },
    estudios: {
      seleccion: casillas(['radiografia_periapical', 'radiografia_panoramica']),
      observaciones:
        'La periapical muestra lesión periapical en la pieza afectada; la panorámica descarta otros focos.',
    },
    diagnostico: {
      principal: 'Infección odontogénica localizada en pieza no restaurable',
      secundarios: 'Alergia a la penicilina documentada',
      porPieza: null,
      saludBucalGeneral: 'regular',
      observaciones:
        'Se contraindica toda la familia de las penicilinas; de requerirse antibiótico se indicará azitromicina.',
    },
    plan: {
      procedimientos: [
        planItem(procedureLabel('extraccion_simple'), 'alta'),
        planItem(procedureLabel('control_postoperatorio'), 'media'),
      ],
      alternativas:
        'Se explica la alternativa de intentar conservar la pieza con endodoncia, con pronóstico reservado por la destrucción coronaria.',
      aceptacionPaciente: true,
      observaciones:
        'Se revisa la historia clínica antes de prescribir y se registra la alergia en un lugar visible.',
    },
    consentimiento: {
      riesgosInformados:
        'Se informa el riesgo de sangrado, infección, dolor postoperatorio y de reacción alérgica a los medicamentos; se aclara que no se usarán penicilinas.',
      alternativasInformadas:
        'Se explican la alternativa conservadora (endodoncia y reconstrucción) y la de no tratar, con progresión de la infección.',
      observaciones: 'Se confirma la alergia antes de firmar el consentimiento.',
    },
    evolucion: {
      resumen:
        'Se evalúa la urgencia, se confirma la alergia a la penicilina y se programa la exodoncia de la pieza no restaurable.',
      observaciones: `Paciente ${wording.oa === 'a' ? 'informada' : 'informado'} del plan y de las alternativas.`,
    },
  }),

  anticoagulado: () => ({
    ocupacion: 'Comerciante',
    lectura:
      'Refiere dolor y movilidad en una pieza posterior; refiere tratamiento anticoagulante.',
    tiempoEvolucion: '1 mes',
    anamnesis: {
      sinAntecedentes: false,
      alergias: casillas(),
      patologicos: casillas(),
      medicamentos: casillas(['anticoagulantes']),
      cirugias: casillas(),
      familiares: casillas(),
      habitos: casillas(),
      observaciones:
        'En tratamiento con warfarina por fibrilación auricular, controlado por cardiología. Refiere INR reciente de 2,3, dentro del rango terapéutico. Sin sangrados espontáneos.',
    },
    antecedentes: {
      tratamientos: casillas(['restauracion', 'extraccion']),
      reaccionesAdversas: casillas(['ninguna']),
      experiencias: casillas(['ninguna']),
      frecuenciaVisitas: 'cuando_molesta',
      ultimaConsulta: null,
      higieneCepillado: 'dos_veces',
      usaHiloDental: false,
      tratamientoEnCurso: null,
      observaciones: 'Refiere extracciones previas sin complicaciones hemorrágicas.',
    },
    extraoral: {
      tejidosBlandos: 'normal',
      ganglios: 'normal',
      atm: 'normal',
      musculatura: 'normal',
      hallazgos:
        'Rostro simétrico, sin equimosis ni petequias. Ganglios no palpables; ATM sin ruidos ni dolor.',
      observaciones: null,
    },
    intraoral: {
      tejidosBlandos: 'normal',
      encias: 'alterado',
      sondaje: 'Sondaje de 2 a 3 mm, sin sangrado espontáneo',
      oclusion: 'normal',
      higiene: 'regular',
      hallazgos:
        'Pieza posterior con destrucción coronaria y movilidad grado II; encías con leve eritema marginal, sin sangrado espontáneo.',
      observaciones: 'Se evitan las maniobras traumáticas sobre los tejidos.',
    },
    estudios: {
      seleccion: casillas(['radiografia_periapical', 'analisis_laboratorio']),
      observaciones:
        'La periapical confirma la pérdida ósea de la pieza; se solicita INR y hematología completa antes del procedimiento.',
    },
    diagnostico: {
      principal: 'Pieza dentaria no restaurable en paciente anticoagulado con riesgo hemorrágico',
      secundarios: 'Gingivitis leve asociada a placa bacteriana',
      porPieza: null,
      saludBucalGeneral: 'regular',
      observaciones:
        'La exodoncia se realizará con hemostasia local y sin suspender el anticoagulante, previa coordinación con cardiología.',
    },
    plan: {
      procedimientos: [
        planItem(procedureLabel('extraccion_simple'), 'alta'),
        planItem(procedureLabel('retiro_sutura'), 'media'),
        planItem(procedureLabel('control_postoperatorio'), 'media'),
      ],
      alternativas:
        'Se explica la alternativa de posponer la exodoncia hasta ajustar el tratamiento anticoagulante, con el riesgo de progresión de la infección.',
      aceptacionPaciente: true,
      observaciones:
        'Se coordina con cardiología y se indica hemostasia con gasa, sutura y frío local.',
    },
    consentimiento: {
      riesgosInformados:
        'Se informa el riesgo aumentado de sangrado persistente, hematoma e infección, y la necesidad de acudir de inmediato si el sangrado no cede.',
      alternativasInformadas:
        'Se explican las alternativas de tratamiento conservador y de exodoncia con ajuste previo del anticoagulante por parte de cardiología.',
      observaciones: 'El paciente comprende que no debe suspender la warfarina por su cuenta.',
    },
    evolucion: {
      resumen:
        'Se verifica el INR, se evalúa la pieza no restaurable y se programa la exodoncia con control de la hemostasia.',
      observaciones: 'Se entregan indicaciones postoperatorias por escrito.',
    },
  }),

  pediatrico: ({ age, wording }) => {
    const temporal = age <= 12;
    return {
      ocupacion: 'Estudiante',
      lectura: temporal
        ? 'El representante refiere molestias al comer y una pieza con cambio de color.'
        : 'El representante refiere sensibilidad al frío y sangrado de encías al cepillarse.',
      tiempoEvolucion: '2 semanas',
      anamnesis: {
        sinAntecedentes: false,
        alergias: casillas(),
        patologicos: casillas(),
        medicamentos: casillas(),
        cirugias: casillas(),
        familiares: casillas(['malformacion_dental']),
        habitos: casillas(temporal ? ['onicofagia'] : ['respiracion_bucal']),
        observaciones:
          'Sin alergias conocidas ni antecedentes patológicos referidos por el representante. Esquema de vacunación completo. Refiere hábitos de succión y onicofagia.',
      },
      antecedentes: {
        tratamientos: casillas(['restauracion']),
        reaccionesAdversas: casillas(['ninguna']),
        experiencias: casillas(temporal ? ['ansiedad'] : ['ninguna']),
        frecuenciaVisitas: 'semestral',
        ultimaConsulta: null,
        higieneCepillado: 'dos_veces',
        usaHiloDental: false,
        tratamientoEnCurso: null,
        observaciones:
          'El representante refiere cepillado supervisado dos veces al día con crema dental fluorada y consumo frecuente de golosinas.',
      },
      extraoral: {
        tejidosBlandos: 'normal',
        ganglios: 'normal',
        atm: 'normal',
        musculatura: 'normal',
        hallazgos:
          'Rostro simétrico; ganglios cervicales no palpables; ATM sin ruidos ni dolor; perfil facial con tendencia a la respiración bucal.',
        observaciones: null,
      },
      intraoral: {
        tejidosBlandos: 'normal',
        encias: 'alterado',
        sondaje: temporal ? null : 'Sondaje de 2 mm generalizado, sin sangrado',
        oclusion: temporal ? 'mordida_abierta' : 'apinamiento',
        higiene: 'regular',
        hallazgos: temporal
          ? 'Dentición temporal completa; molares temporales con lesiones de caries oclusales; gingivitis marginal leve; mordida abierta anterior asociada a hábito de succión.'
          : 'Lesiones de caries oclusales en premolares y molares; gingivitis marginal leve; apiñamiento anterior leve.',
        observaciones: 'Se refuerza la higiene supervisada y el control de la dieta.',
      },
      estudios: {
        seleccion: casillas(['aleta_mordida', 'fotografias_clinicas']),
        observaciones:
          'Las aletas de mordida muestran lesiones oclusales sin compromiso pulpar; se toman fotografías clínicas para el seguimiento.',
      },
      diagnostico: {
        principal: temporal
          ? 'Caries de la infancia temprana en molares temporales'
          : 'Caries dental en dentición mixta',
        secundarios: temporal
          ? 'Gingivitis asociada a placa bacteriana; hábito de succión'
          : 'Gingivitis asociada a placa bacteriana; apiñamiento leve',
        porPieza: null,
        saludBucalGeneral: 'regular',
        observaciones:
          'Riesgo cariogénico alto por dieta cariogénica y cepillado supervisado una sola vez al día.',
      },
      plan: {
        procedimientos: [
          planItem(`${procedureLabel('obturacion_ionomero')} en las piezas afectadas`, 'alta'),
          planItem(procedureLabel('aplicacion_fluor'), 'media'),
          planItem(procedureLabel('sellante'), 'media'),
          planItem(procedureLabel('control_postoperatorio'), 'baja'),
        ],
        alternativas:
          'Si la lesión compromete la pulpa se valorará pulpotomía o corona temporal (acero) en molares temporales; nunca coronas de porcelana en dentición temporal.',
        aceptacionPaciente: true,
        observaciones:
          'Se explica al representante el plan por sesiones, el control de dieta y la técnica de cepillado supervisado.',
      },
      consentimiento: {
        riesgosInformados:
          'Se informa al representante que las restauraciones pueden producir sensibilidad transitoria y que el tratamiento en dentición temporal requiere control periódico.',
        alternativasInformadas:
          'Se explica la alternativa de aplicación de flúor y control de dieta sin restaurar de inmediato, con seguimiento estrecho.',
        observaciones: `El representante de ${wording.sujeto} comprende y acepta el plan de tratamiento.`,
      },
      evolucion: {
        resumen:
          'Se evalúa al menor, se confirma el plan restaurador y preventivo, y se refuerzan la higiene supervisada y el control de la dieta.',
        observaciones: 'Se cita para continuar el plan por sesiones.',
      },
    };
  },

  edentulo_parcial: ({ wording }) => ({
    ocupacion: 'Pensionado',
    lectura: `Refiere dificultad para masticar y molestias con la prótesis que usa; ${wording.adultoMayor ? 'es adulto mayor' : 'tiene pérdida de varias piezas'}.`,
    tiempoEvolucion: '1 año',
    anamnesis: {
      sinAntecedentes: false,
      alergias: casillas(),
      patologicos: casillas(['hipertension', 'otros'], 'Artrosis de rodilla y gastritis crónica'),
      medicamentos: casillas(['antihipertensivos']),
      cirugias: casillas(['extraccion_dental']),
      familiares: casillas(),
      habitos: casillas(),
      observaciones:
        'Hipertensión arterial controlada con losartán y artrosis de rodilla en tratamiento con analgesia. Refiere gastritis crónica. Usa prótesis parcial removible antigua que le produce molestias.',
    },
    antecedentes: {
      tratamientos: casillas(['protesis', 'extraccion']),
      reaccionesAdversas: casillas(['ninguna']),
      experiencias: casillas(['ninguna']),
      frecuenciaVisitas: 'anual',
      ultimaConsulta: null,
      higieneCepillado: 'una_vez',
      usaHiloDental: false,
      tratamientoEnCurso: null,
      observaciones:
        'Usa prótesis parcial removible superior desde hace más de diez años, con desadaptación y movilidad.',
    },
    extraoral: {
      tejidosBlandos: 'normal',
      ganglios: 'normal',
      atm: 'alterado',
      musculatura: 'normal',
      hallazgos:
        'Rostro con surcos nasogenianos marcados; ganglios no palpables; ATM con crepitación leve y limitación a la apertura amplia.',
      observaciones: null,
    },
    intraoral: {
      tejidosBlandos: 'alterado',
      encias: 'alterado',
      sondaje: 'Sondaje de 3 mm en piezas remanentes',
      oclusion: 'sin_dato',
      higiene: 'regular',
      hallazgos:
        'Edentulismo parcial con rebordes alveolares reabsorbidos; hiperplasia fibrosa del vestíbulo por la prótesis desadaptada; piezas remanentes con movilidad y cálculo.',
      observaciones: 'Se retira la prótesis para el examen y se revisan los apoyos.',
    },
    estudios: {
      seleccion: casillas(['radiografia_panoramica', 'modelos_estudio']),
      observaciones:
        'Panorámica con reabsorción ósea horizontal y senos maxilares neumatizados; se toman modelos de estudio para la nueva prótesis.',
    },
    diagnostico: {
      principal: 'Edentulismo parcial con prótesis removible desadaptada',
      secundarios:
        'Hiperplasia fibrosa por prótesis; hipertensión arterial controlada; piezas remanentes no restaurables',
      porPieza: null,
      saludBucalGeneral: 'regular',
      observaciones:
        'Se indica la exodoncia de las piezas no recuperables antes de confeccionar la prótesis definitiva.',
    },
    plan: {
      procedimientos: [
        planItem(procedureLabel('extraccion_simple'), 'alta'),
        planItem(procedureLabel('protesis_removible'), 'media'),
        planItem(procedureLabel('control_postoperatorio'), 'media'),
      ],
      alternativas:
        'Se plantean la rehabilitación con prótesis parcial removible nueva y, como alternativa, el tratamiento con implantes, de mayor costo.',
      aceptacionPaciente: true,
      observaciones:
        'Se ajusta la prótesis actual mientras se completa el plan y se indica higiene de la prótesis.',
    },
    consentimiento: {
      riesgosInformados:
        'Se informa el riesgo de sangrado, infección y reabsorción del reborde, y la necesidad de controles periódicos para ajustar la prótesis.',
      alternativasInformadas:
        'Se explican las alternativas protésicas (removible o implantes) con sus ventajas, costos y tiempos.',
      observaciones: 'El paciente y su familia comprenden el plan y aceptan la prótesis removible.',
    },
    evolucion: {
      resumen:
        'Se evalúa el estado de la prótesis y de las piezas remanentes, se indica la exodoncia de las no recuperables y se planifica la nueva prótesis.',
      observaciones: 'Se explican los cuidados de la prótesis y la higiene de los rebordes.',
    },
  }),
};

/** Ocupación coherente con la edad: un niño no es «comerciante» ni un jubilado estudia. */
const ocupacionFor = (
  perfil: TestClinicalProfile,
  age: number,
  sex: Sex,
  adulta: string,
): string => {
  if (age < 6) return 'Preescolar';
  if (age < 18) return 'Estudiante';
  if (perfil === 'edentulo_parcial' || age >= 65) return sex === 'F' ? 'Pensionada' : 'Pensionado';
  return adulta;
};

/**
 * Historia clínica completa del paciente ficticio: las once secciones, listas para
 * `medical_record_sections.content`.
 *
 * El motivo que escribió el paciente en su solicitud viaja **textual** dentro del
 * relato (la historia clínica es, antes que nada, un documento legal): lo que
 * cambia por perfil es la lectura clínica que lo acompaña.
 */
export const buildRecordSections = (input: {
  profile: TestClinicalProfile;
  sex: Sex;
  age: number;
  reason: string;
  fullName: string;
}): Record<ClinicalSectionKey, Record<string, unknown>> => {
  const wording = wordingFor(input.sex, input.age);
  const contenido = RECORD_BUILDERS[input.profile]({ age: input.age, wording });
  const relato = limitar(
    `${capitalizar(wording.sujeto)} refiere, con sus propias palabras: «${input.reason}». ${contenido.lectura}`,
    1000,
  );

  return {
    identificacion: {
      ocupacion: ocupacionFor(input.profile, input.age, input.sex, contenido.ocupacion),
      responsableNombre: null,
      responsableParentesco: null,
      responsableTelefono: null,
      observaciones: wording.pediatrico
        ? `Paciente menor de edad (${String(input.age)} años): los datos del representante constan en la ficha del paciente ${input.fullName}.`
        : `Paciente adulto (${String(input.age)} años); los datos de contacto y la dirección constan en la ficha del paciente.`,
    },
    motivo_consulta: {
      relato,
      tiempoEvolucion: contenido.tiempoEvolucion,
      inicioSintomas: null,
    },
    anamnesis: { ...contenido.anamnesis },
    antecedentes_odontologicos: { ...contenido.antecedentes },
    examen_extraoral: { ...contenido.extraoral },
    examen_intraoral: { ...contenido.intraoral },
    examenes_complementarios: {
      estudios: { ...contenido.estudios.seleccion },
      observaciones: contenido.estudios.observaciones,
    },
    diagnostico: { ...contenido.diagnostico },
    plan_tratamiento: {
      ...contenido.plan,
      procedimientos: contenido.plan.procedimientos.map((item) => ({ ...item })),
    },
    consentimiento: { ...contenido.consentimiento },
    evolucion: {
      resumen: limitar(
        `${capitalizar(wording.sujeto)} acude a consulta y refiere: «${input.reason}». ${contenido.evolucion.resumen}`,
        2000,
      ),
      observaciones: contenido.evolucion.observaciones,
    },
  };
};

/* ── Sesión clínica por perfil ─────────────────────────────────────────────── */

const procedimiento = (
  code: SessionProcedureCode,
  toothNumber: number | null = null,
  surfaces: readonly ToothSurface[] = [],
): SessionProcedure => ({
  code,
  detalle: null,
  toothNumber,
  surfaces: [...surfaces],
  notas: null,
});

const material = (code: SessionMaterialCode, cantidad: string | null = null): SessionMaterial => ({
  code,
  detalle: null,
  cantidad,
});

/** Caras de una restauración: en anteriores el borde incisal va como «oclusal». */
const carasObturacion = (toothNumber: number, index: number): readonly ToothSurface[] => {
  const posterior = positionOfTooth(toothNumber) >= 4;
  const principal: ToothSurface = posterior ? 'occlusal' : 'vestibular';
  return index % 2 === 0 ? [principal, 'mesial'] : [principal, 'distal'];
};

const procedimientosPorPieza = (
  code: SessionProcedureCode,
  teeth: readonly number[],
  caras: (toothNumber: number, index: number) => readonly ToothSurface[] = () => [],
): SessionProcedure[] =>
  teeth.map((tooth, index) => procedimiento(code, tooth, caras(tooth, index)));

/** Signos vitales del día: solo se toman donde el perfil los justifica. */
const sessionVitals = (
  profile: TestClinicalProfile,
  sessionNumber: number,
): ClinicalSessionContent['vitals'] => {
  const base = emptySessionVitals();
  const paso = (sessionNumber - 1) % 3;
  switch (profile) {
    case 'hipertension':
      return {
        ...base,
        taSistolica: 132 + paso * 4,
        taDiastolica: 82 + paso * 2,
        fc: 72 + paso,
        temperatura: 36.5,
        spo2: 98,
      };
    case 'diabetes':
      return {
        ...base,
        taSistolica: 122 + paso * 3,
        taDiastolica: 76 + paso,
        fc: 76 + paso,
        temperatura: 36.4,
        spo2: 98,
        peso: [78.4, 77.8, 77.2][paso] ?? 78.4,
      };
    case 'anticoagulado':
      return {
        ...base,
        taSistolica: 128,
        taDiastolica: 78,
        fc: 68 + paso,
        temperatura: 36.4,
        spo2: 97,
        peso: [82.3, 82.1, 81.9][paso] ?? 82.3,
      };
    case 'edentulo_parcial':
      return {
        ...base,
        taSistolica: 138 + paso * 2,
        taDiastolica: 84,
        fc: 74 + paso,
        temperatura: 36.3,
        spo2: 97,
        peso: [68.5, 68.2, 67.9][paso] ?? 68.5,
      };
    case 'pediatrico':
      return {
        ...base,
        fc: 92 + paso * 2,
        temperatura: [36.5, 36.6, 36.7][paso] ?? 36.5,
        spo2: 99,
        peso: [24, 25.5, 27][paso] ?? 24,
      };
    default:
      return base;
  }
};

type SessionContext = {
  teeth: readonly number[];
  sessionNumber: number;
  /** Dentición temporal o perfil pediátrico: cambia procedimientos y textos. */
  pediatrico: boolean;
};

type SessionBlueprint = {
  anamnesis: string;
  vitals: ClinicalSessionContent['vitals'];
  exam: ClinicalSessionContent['exam'];
  procedimientos: SessionProcedure[];
  materiales: SessionMaterial[];
  diagnostico: string;
  indicaciones: string;
  proximaCitaNota: string;
  notasInternas: string;
};

/**
 * Qué se hizo en cada sesión, por perfil. La sesión 1 abre el plan y las
 * siguientes lo continúan (retiro de sutura, control, prótesis), que es lo que
 * hace que la evolución del paciente se lea como un tratamiento y no como una
 * lista de procedimientos sueltos.
 */
const SESSION_BUILDERS: Readonly<
  Record<TestClinicalProfile, (context: SessionContext) => SessionBlueprint>
> = {
  sano: ({ teeth, sessionNumber }) => ({
    anamnesis:
      'Paciente asintomático; sin cambios en su estado general desde la última visita. Refiere cumplir el cepillado y el uso de hilo dental.',
    vitals: sessionVitals('sano', sessionNumber),
    exam: {
      ...emptySessionExam(),
      tejidosBlandos: 'normal',
      encias: 'normal',
      oclusion: 'normal',
      higiene: 'buena',
      hallazgos:
        'Mucosa oral sin lesiones; sin cálculo visible; dentición sin caries activas ni restauraciones deficientes.',
    },
    procedimientos: [procedimiento('profilaxis'), ...procedimientosPorPieza('radiografia', teeth)],
    materiales: [material('fluor_gel', '1 aplicación')],
    diagnostico: `Sin lesiones activas; se realiza profilaxis y control radiográfico de ${piezasTexto(teeth)}.`,
    indicaciones:
      'Mantenga el cepillado después de cada comida y el uso de hilo dental. Regrese a control en seis meses.',
    proximaCitaNota: 'Control semestral',
    notasInternas: 'Se refuerza la técnica de cepillado.',
  }),

  caries_multiple: ({ teeth, sessionNumber, pediatrico }) => ({
    anamnesis: pediatrico
      ? 'El representante refiere que el menor consume golosinas y jugos entre comidas y que el cepillado es supervisado una vez al día.'
      : 'Paciente refiere sensibilidad al frío y dolor breve al masticar en varias piezas.',
    vitals: sessionVitals('caries_multiple', sessionNumber),
    exam: {
      ...emptySessionExam(),
      tejidosBlandos: 'normal',
      encias: 'alterado',
      sondaje: pediatrico ? null : 'Sondaje de 2 a 3 mm, sin pérdida de inserción',
      oclusion: pediatrico ? 'normal' : 'apinamiento',
      higiene: 'deficiente',
      hallazgos: pediatrico
        ? 'Molares temporales con lesiones de caries oclusales y proximales; esmalte con hipomineralización en incisivos; gingivitis marginal leve.'
        : 'Lesiones de caries oclusales y proximales en varios sectores; restauraciones con márgenes desadaptados; gingivitis marginal.',
    },
    procedimientos: [
      procedimiento(pediatrico ? 'aplicacion_fluor' : 'consulta_evaluacion'),
      ...procedimientosPorPieza(
        pediatrico ? 'obturacion_ionomero' : 'obturacion_resina',
        teeth,
        carasObturacion,
      ),
    ],
    materiales: pediatrico
      ? [material('ionomero_vidrio', '1 dosificación'), material('fluor_gel', '1 aplicación')]
      : [material('resina_compuesta', '1 jeringa'), material('anestesia_lidocaina', '1 cartucho')],
    diagnostico: pediatrico
      ? `Caries de la infancia temprana en ${piezasTexto(teeth)} (dentición temporal); se restauran las lesiones.`
      : `Caries dental activa en ${piezasTexto(teeth)}; se restauran las lesiones con resina compuesta.`,
    indicaciones: pediatrico
      ? 'Supervise el cepillado dos veces al día con crema fluorada y reduzca los jugos y las golosinas entre comidas.'
      : 'Evite alimentos duros sobre las restauraciones durante 24 horas y mantenga el cepillado con hilo dental.',
    proximaCitaNota: 'Control de restauraciones en 15 días',
    notasInternas: 'Riesgo cariogénico alto: se refuerzan la higiene y el control de la dieta.',
  }),

  periodontal: ({ teeth, sessionNumber }) => ({
    anamnesis:
      'Paciente refiere sangrado gingival al cepillarse y mal aliento. Sin cambios en su estado general.',
    vitals: sessionVitals('periodontal', sessionNumber),
    exam: {
      ...emptySessionExam(),
      tejidosBlandos: 'normal',
      encias: 'alterado',
      sondaje: sondajeTexto(teeth),
      oclusion: 'apinamiento',
      higiene: 'deficiente',
      hallazgos:
        'Cálculo supragingival y placa bacteriana en sectores posteriores; encías eritematosas con sangrado al sondaje.',
    },
    procedimientos: [
      procedimiento(sessionNumber === 1 ? 'profilaxis' : 'control_postoperatorio'),
      ...procedimientosPorPieza('detartraje', teeth),
    ],
    materiales: [material('anestesia_lidocaina', '1 cartucho')],
    diagnostico: `Enfermedad periodontal con cálculo en ${piezasTexto(teeth)}; se realiza detartraje y alisado radicular.`,
    indicaciones:
      'Cepille con técnica de Bass modificada tres veces al día y use hilo dental; evite los alimentos pegajosos.',
    proximaCitaNota: 'Control periodontal en 15 días',
    notasInternas: 'Se instruye en técnica de cepillado y se entrega cepillo periodontal.',
  }),

  diabetes: ({ teeth, sessionNumber }) => ({
    anamnesis:
      'Paciente con diabetes mellitus tipo 2; refiere glicemia de 128 mg/dl en ayunas y buen apego al tratamiento.',
    vitals: sessionVitals('diabetes', sessionNumber),
    exam: {
      ...emptySessionExam(),
      tejidosBlandos: 'alterado',
      encias: 'alterado',
      sondaje: 'Sondaje de 3 a 4 mm en sectores posteriores, con sangrado',
      oclusion: 'normal',
      higiene: 'regular',
      hallazgos:
        'Encías con inflamación marginal y cálculo supragingival; xerostomía leve; restauraciones con márgenes desadaptados.',
    },
    procedimientos: [
      procedimiento(sessionNumber === 1 ? 'consulta_evaluacion' : 'control_postoperatorio'),
      ...procedimientosPorPieza('obturacion_resina', teeth, carasObturacion),
    ],
    materiales: [
      material('resina_compuesta', '1 jeringa'),
      material('anestesia_lidocaina', '1 cartucho'),
    ],
    diagnostico: `Caries dental en ${piezasTexto(teeth)}; enfermedad periodontal leve asociada a diabetes mellitus tipo 2.`,
    indicaciones:
      'Mantenga el control metabólico y el cepillado tres veces al día; acuda a control periodontal cada tres meses.',
    proximaCitaNota: 'Control a los 15 días',
    notasInternas:
      'Se recomienda interconsulta con su médico tratante antes de procedimientos quirúrgicos.',
  }),

  hipertension: ({ teeth, sessionNumber }) => ({
    anamnesis:
      'Paciente hipertenso controlado; refiere haber tomado su medicación antihipertensiva en la mañana.',
    vitals: sessionVitals('hipertension', sessionNumber),
    exam: {
      ...emptySessionExam(),
      tejidosBlandos: 'normal',
      encias: 'alterado',
      sondaje: 'Sondaje de 2 a 3 mm, sin sangrado',
      oclusion: 'normal',
      higiene: 'regular',
      hallazgos:
        'Cálculo supragingival leve; restauraciones de amalgama con márgenes desadaptados y caries recurrente en sectores posteriores.',
    },
    procedimientos: [
      procedimiento('profilaxis'),
      ...procedimientosPorPieza('obturacion_resina', teeth, carasObturacion),
    ],
    materiales: [
      material('resina_compuesta', '1 jeringa'),
      material('anestesia_lidocaina', '1 cartucho'),
    ],
    diagnostico: `Caries dental recurrente en ${piezasTexto(teeth)}; paciente hipertenso controlado (TA 132/82 mmHg).`,
    indicaciones:
      'No suspenda su medicación antihipertensiva y mantenga el cepillado con hilo dental después de cada comida.',
    proximaCitaNota: 'Control en 15 días',
    notasInternas: 'Se toma la tensión arterial al inicio y al final de la consulta.',
  }),

  alergia_penicilina: ({ teeth, sessionNumber }) => ({
    anamnesis:
      'Paciente refiere alergia a la penicilina con erupción cutánea; se reconfirma el antecedente antes de indicar cualquier antibiótico.',
    vitals: sessionVitals('alergia_penicilina', sessionNumber),
    exam: {
      ...emptySessionExam(),
      tejidosBlandos: 'alterado',
      encias: 'alterado',
      oclusion: 'normal',
      higiene: 'regular',
      hallazgos:
        'Pieza posterior con destrucción coronaria y restos radiculares; encía adyacente eritematosa con supuración al sondaje.',
    },
    procedimientos: [
      procedimiento(sessionNumber === 1 ? 'consulta_evaluacion' : 'control_postoperatorio'),
      ...procedimientosPorPieza('extraccion_simple', teeth),
    ],
    materiales: [
      material('anestesia_lidocaina', '2 cartuchos'),
      material('sutura_seda', '1 sobre'),
    ],
    diagnostico: `${capitalizar(piezasTexto(teeth))} no restaurable${teeth.length === 1 ? '' : 's'} con infección odontogénica localizada; alergia a la penicilina.`,
    indicaciones:
      'Mantenga la gasa mordida 30 minutos; no escupa, no fume ni use pajita durante 24 horas. Si el sangrado no cede o aparece fiebre, acuda de inmediato.',
    proximaCitaNota: 'Control postoperatorio en 7 días',
    notasInternas:
      'Alergia a la penicilina verificada en la historia. Si requiere antibiótico se indicará azitromicina.',
  }),

  anticoagulado: ({ teeth, sessionNumber }) => {
    const primera = sessionNumber === 1;
    return {
      anamnesis: primera
        ? 'Paciente anticoagulado con warfarina; se verifica INR de 2,3 con el laboratorio y refiere no tener sangrados espontáneos.'
        : 'Paciente anticoagulado en control postoperatorio; refiere evolución favorable y ausencia de sangrado.',
      vitals: sessionVitals('anticoagulado', sessionNumber),
      exam: {
        ...emptySessionExam(),
        tejidosBlandos: 'normal',
        encias: 'alterado',
        sondaje: 'Sondaje de 2 a 3 mm, sin sangrado espontáneo',
        oclusion: 'normal',
        higiene: 'regular',
        hallazgos: primera
          ? 'Pieza posterior con destrucción coronaria y movilidad grado II; encías con eritema marginal leve, sin sangrado espontáneo.'
          : 'Alvéolo en cicatrización, sin signos de infección ni sangrado activo; tejidos vecinos sin alteraciones.',
      },
      procedimientos: primera
        ? [
            procedimiento('consulta_evaluacion'),
            ...procedimientosPorPieza('extraccion_simple', teeth),
          ]
        : [
            procedimiento('retiro_sutura'),
            ...procedimientosPorPieza('control_postoperatorio', teeth),
          ],
      materiales: primera
        ? [material('anestesia_mepivacaina', '2 cartuchos'), material('sutura_seda', '1 sobre')]
        : [],
      diagnostico: primera
        ? `${capitalizar(piezasTexto(teeth))} no restaurable${teeth.length === 1 ? '' : 's'}; exodoncia en paciente anticoagulado con INR 2,3.`
        : 'Control postoperatorio: alvéolo en cicatrización sin signos de infección.',
      indicaciones: primera
        ? 'Mantenga la gasa mordida 45 minutos; no escupa, no fume ni haga esfuerzos durante 24 horas. Continúe la warfarina según indicación de cardiología y acuda si el sangrado no cede.'
        : 'Mantenga la zona limpia con enjuagues suaves de solución fisiológica y vuelva al control indicado.',
      proximaCitaNota: primera ? 'Control postoperatorio en 7 días' : 'Alta del postoperatorio',
      notasInternas: primera
        ? 'Se verificó el INR antes del procedimiento y se coordinó con cardiología. Hemostasia con gasa, sutura y frío local.'
        : 'Se revisa la hemostasia y se refuerzan las indicaciones de higiene.',
    };
  },

  edentulo_parcial: ({ teeth, sessionNumber }) => {
    const primera = sessionNumber === 1;
    return {
      anamnesis: primera
        ? 'Paciente adulto mayor refiere dificultad para masticar y molestias con la prótesis antigua; usa antihipertensivos.'
        : 'Paciente refiere buena evolución del postoperatorio y acude para la toma de impresiones de la prótesis nueva.',
      vitals: sessionVitals('edentulo_parcial', sessionNumber),
      exam: {
        ...emptySessionExam(),
        tejidosBlandos: primera ? 'alterado' : 'normal',
        encias: 'alterado',
        sondaje: primera ? sondajeTexto(teeth) : 'Sondaje de 3 mm en piezas remanentes',
        oclusion: 'sin_dato',
        higiene: 'regular',
        hallazgos: primera
          ? 'Edentulismo parcial con rebordes reabsorbidos; hiperplasia fibrosa del vestíbulo por prótesis desadaptada; piezas remanentes con movilidad y cálculo.'
          : 'Rebordes en buen estado para la impresión; sin zonas dolorosas; alvéolos cicatrizados.',
      },
      procedimientos: primera
        ? [
            procedimiento('consulta_evaluacion'),
            ...procedimientosPorPieza('extraccion_simple', teeth),
          ]
        : [
            procedimiento('protesis_removible'),
            ...procedimientosPorPieza('control_postoperatorio', teeth),
          ],
      materiales: primera
        ? [material('anestesia_lidocaina', '2 cartuchos'), material('sutura_seda', '1 sobre')]
        : [material('alginato', '1 medida'), material('yeso_piedra', '500 g')],
      diagnostico: primera
        ? `Edentulismo parcial; ${piezasTexto(teeth)} no restaurable${teeth.length === 1 ? '' : 's'}. Se indica exodoncia y rehabilitación protésica.`
        : 'Edentulismo parcial; se toman impresiones para la prótesis parcial removible.',
      indicaciones: primera
        ? 'Mantenga la gasa mordida 30 minutos; no escupa ni fume durante 24 horas. Retire la prótesis antigua por las noches y limpiela con cepillo.'
        : 'Use la prótesis solo para comer durante los primeros días y retírela por las noches; acuda a los ajustes.',
      proximaCitaNota: primera
        ? 'Control postoperatorio en 7 días'
        : 'Prueba de la prótesis en 15 días',
      notasInternas: primera
        ? 'Se ajusta la prótesis actual mientras se completa el plan quirúrgico.'
        : 'Se verifican la oclusión y los apoyos de la prótesis en prueba.',
    };
  },

  pediatrico: ({ teeth, sessionNumber, pediatrico }) => ({
    anamnesis:
      'El representante refiere que el menor ha estado molesto al comer y que el cepillado se supervisa dos veces al día.',
    vitals: sessionVitals('pediatrico', sessionNumber),
    exam: {
      ...emptySessionExam(),
      tejidosBlandos: 'normal',
      encias: 'alterado',
      oclusion: pediatrico ? 'mordida_abierta' : 'apinamiento',
      higiene: 'regular',
      hallazgos: pediatrico
        ? 'Molares temporales con lesiones de caries oclusales; gingivitis marginal leve; mordida abierta anterior asociada a hábito de succión.'
        : 'Lesiones de caries oclusales; gingivitis marginal leve; apiñamiento anterior leve.',
    },
    procedimientos: [
      procedimiento('aplicacion_fluor'),
      ...procedimientosPorPieza(
        pediatrico ? 'obturacion_ionomero' : 'sellante',
        teeth,
        carasObturacion,
      ),
    ],
    materiales: pediatrico
      ? [material('fluor_gel', '1 aplicación'), material('ionomero_vidrio', '1 dosificación')]
      : [material('fluor_gel', '1 aplicación'), material('sellante_resina', '1 jeringa')],
    diagnostico: pediatrico
      ? `Caries de la infancia temprana en ${piezasTexto(teeth)} (dentición temporal); se restauran con ionómero de vidrio.`
      : `Caries oclusal en ${piezasTexto(teeth)}; se aplica sellante de fosas y fisuras.`,
    indicaciones:
      'Supervise el cepillado dos veces al día con crema fluorada; reduzca los jugos y las golosinas entre comidas.',
    proximaCitaNota: 'Control en 3 meses',
    notasInternas:
      'Se explica al representante la técnica de cepillado y la importancia de la dieta. No se indican coronas de porcelana en dentición temporal.',
  }),
};

/**
 * Contenido de una sesión cerrada, válido para `clinical_sessions.content`.
 *
 * Los procedimientos y los materiales salen del catálogo real de la sesión y las
 * piezas son las que el mundo eligió: lo que se hizo, dónde y con qué.
 */
export const buildSessionContent = (input: {
  profile: TestClinicalProfile;
  reason: string;
  teeth: readonly number[];
  sessionNumber: number;
}): ClinicalSessionContent => {
  // Si el mundo colara una pieza que no existe en FDI se ignora: la sesión nunca
  // se guarda con una pieza imposible.
  const teeth = input.teeth.filter((tooth) => isToothNumber(tooth));
  const pediatrico = input.profile === 'pediatrico' || teeth.some((tooth) => isPrimaryTooth(tooth));
  const blueprint = SESSION_BUILDERS[input.profile]({
    teeth,
    sessionNumber: input.sessionNumber,
    pediatrico,
  });
  // Los dos textos libres del examen pueden venir nulos en el tipo del contrato;
  // se recortan al tope para que un motivo largo no rompa el guardado.
  const sondaje = blueprint.exam.sondaje;
  const hallazgos = blueprint.exam.hallazgos;

  return {
    motivo: limitar(
      input.sessionNumber === 1
        ? input.reason
        : `${input.reason}. Continúa el plan de tratamiento (sesión ${String(input.sessionNumber)}).`,
      500,
    ),
    anamnesis: limitar(blueprint.anamnesis, 2000),
    vitals: blueprint.vitals,
    exam: {
      ...blueprint.exam,
      sondaje: sondaje === null ? null : limitar(sondaje, 300),
      hallazgos: hallazgos === null ? null : limitar(hallazgos, 2000),
    },
    procedimientos: blueprint.procedimientos,
    materiales: blueprint.materiales,
    diagnostico: limitar(blueprint.diagnostico, 1000),
    indicaciones: limitar(blueprint.indicaciones, 2000),
    proximaCitaFecha: null,
    proximaCitaNota: limitar(blueprint.proximaCitaNota, 300),
    // El mundo de prueba no crea la cita de la sugerencia: deja la nota, como una
    // sesión cerrada sin pasar por el cuadro de confirmación (ADR 0052).
    proximaCitaAppointmentId: null,
    notasInternas: limitar(blueprint.notasInternas, 2000),
  };
};

/* ── Récipes ───────────────────────────────────────────────────────────────── */

type Situation = {
  dolor: boolean;
  infeccion: boolean;
  sangrado: boolean;
  /** Dentición temporal o perfil pediátrico: cambia la presentación y la dosis. */
  pediatrico: boolean;
};

/**
 * Palabras que delatan la situación clínica del motivo. Se comparan sin acentos y
 * en minúsculas, así que el mismo motivo escrito de dos maneras decide igual.
 */
const SITUATION_WORDS = {
  dolor: ['dolor', 'duele', 'duelen', 'molest', 'sensib', 'punzad', 'arde'],
  infeccion: ['infecc', 'pus', 'absces', 'inflam', 'hincha', 'fiebre', 'supura', 'flemon'],
  sangrado: ['sangr', 'hemorrag', 'sangra'],
} as const;

const situationOf = (reason: string, pediatrico: boolean): Situation => {
  const texto = reason
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const contiene = (palabras: readonly string[]): boolean =>
    palabras.some((palabra) => texto.includes(palabra));
  return {
    dolor: contiene(SITUATION_WORDS.dolor),
    infeccion: contiene(SITUATION_WORDS.infeccion),
    sangrado: contiene(SITUATION_WORDS.sangrado),
    pediatrico,
  };
};

type MedicationKey =
  | 'amoxicilina'
  | 'azitromicina'
  | 'clindamicina'
  | 'metronidazol'
  | 'ibuprofeno'
  | 'paracetamol'
  | 'clorhexidina';

type MedicationSeed = {
  /** Nombre exacto de `medications_catalog` (migración 0002 de `clinical`). */
  name: string;
  presentation: string;
  pediatricPresentation: string | null;
  route: MedicationRoute;
  dose: string;
  pediatricDose: string | null;
  frequency: string;
  duration: string | null;
  instructions: string | null;
  quantity: string;
  pediatricQuantity: string | null;
};

/**
 * Espejo del catálogo de la migración 0002 con los medicamentos que usan los
 * récipes del mundo. El mundo puede pasar el catálogo vivo (con sus presentaciones
 * y vías reales) y entonces manda el vivo; esto es el respaldo para que un récipe
 * sembrado nunca quede con un nombre que no exista en la base.
 */
const MEDICATIONS: Readonly<Record<MedicationKey, MedicationSeed>> = {
  amoxicilina: {
    name: 'Amoxicilina',
    presentation: 'Tabletas 500 mg',
    pediatricPresentation: 'Suspensión 250 mg/5 ml',
    route: 'oral',
    dose: '500 mg',
    pediatricDose: '50 mg/kg al día repartidos cada 8 horas (según peso)',
    frequency: 'cada 8 horas',
    duration: '7 días',
    instructions: 'Completar el tratamiento aunque los síntomas cedan; tomarlo con alimentos.',
    quantity: '21 tabletas',
    pediatricQuantity: '1 frasco de 60 ml',
  },
  azitromicina: {
    name: 'Azitromicina',
    presentation: 'Tabletas 500 mg',
    pediatricPresentation: 'Suspensión 200 mg/5 ml',
    route: 'oral',
    dose: '500 mg',
    pediatricDose: '10 mg/kg al día (según peso)',
    frequency: 'cada 24 horas',
    duration: '3 días',
    instructions:
      'Tomarlo a la misma hora cada día; no requiere ajuste en la insuficiencia renal leve.',
    quantity: '3 tabletas',
    pediatricQuantity: '1 frasco',
  },
  clindamicina: {
    name: 'Clindamicina',
    presentation: 'Cápsulas 300 mg',
    pediatricPresentation: null,
    route: 'oral',
    dose: '300 mg',
    pediatricDose: null,
    frequency: 'cada 6 a 8 horas',
    duration: '7 días',
    instructions: 'Tomarlo con un vaso de agua y suspender si aparece diarrea intensa.',
    quantity: '28 cápsulas',
    pediatricQuantity: null,
  },
  metronidazol: {
    name: 'Metronidazol',
    presentation: 'Tabletas 500 mg',
    pediatricPresentation: null,
    route: 'oral',
    dose: '500 mg',
    pediatricDose: null,
    frequency: 'cada 8 horas',
    duration: '7 días',
    instructions: 'No consumir alcohol durante el tratamiento ni en los tres días siguientes.',
    quantity: '21 tabletas',
    pediatricQuantity: null,
  },
  ibuprofeno: {
    name: 'Ibuprofeno',
    presentation: 'Tabletas 400 mg',
    pediatricPresentation: 'Suspensión 100 mg/5 ml',
    route: 'oral',
    dose: '400 a 600 mg',
    pediatricDose: '5 a 10 mg/kg por toma (según peso)',
    frequency: 'cada 6 a 8 horas',
    duration: '5 días',
    instructions: 'Tomarlo después de comer y suspenderlo si aparecen molestias gástricas.',
    quantity: '20 tabletas',
    pediatricQuantity: '1 frasco de 120 ml',
  },
  paracetamol: {
    name: 'Paracetamol',
    presentation: 'Tabletas 500 mg',
    pediatricPresentation: 'Jarabe 120 mg/5 ml',
    route: 'oral',
    dose: '500 mg a 1 g',
    pediatricDose: '10 a 15 mg/kg por toma (según peso)',
    frequency: 'cada 6 a 8 horas',
    duration: '3 días',
    instructions:
      'No exceder 4 dosis al día ni combinarlo con otros productos que contengan paracetamol.',
    quantity: '12 tabletas',
    pediatricQuantity: '1 frasco de 120 ml',
  },
  clorhexidina: {
    name: 'Clorhexidina',
    presentation: 'Enjuague 0,12 %',
    pediatricPresentation: null,
    route: 'topica',
    dose: '15 ml',
    pediatricDose: null,
    frequency: 'enjuagues cada 12 horas',
    duration: '7 días',
    instructions: 'No enjuagar con agua; usarlo 30 minutos después del cepillado.',
    quantity: '1 frasco de 240 ml',
    pediatricQuantity: null,
  },
};

/** Entrada del catálogo vivo: lo que devuelve `clinical` al consultar los medicamentos. */
export type TestMedicationCatalogEntry = {
  name: string;
  presentations: unknown;
  routes: unknown;
};

export type TestPrescriptionItem = {
  medicationName: string;
  presentation: string | null;
  route: MedicationRoute | null;
  dose: string;
  frequency: string;
  duration: string | null;
  instructions: string | null;
  quantity: string | null;
};

export type TestPrescription = {
  generalInstructions: string;
  items: readonly TestPrescriptionItem[];
};

const textList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const isMedicationRoute = (value: unknown): value is MedicationRoute =>
  MEDICATION_ROUTES.some((route) => route === value);

const routeList = (value: unknown): MedicationRoute[] => textList(value).filter(isMedicationRoute);

/** Presentación de un texto de presentaciones: jarabe o suspensión para el niño, tableta para el adulto. */
const pickPresentation = (presentations: readonly string[], pediatrico: boolean): string | null => {
  const pediatrica = presentations.find((item) => /suspensi|jarabe/i.test(item));
  if (pediatrico) return pediatrica ?? null;
  const adulta = presentations.find((item) => /tableta|c[aá]psula|enjuague|gel/i.test(item));
  return adulta ?? presentations[0] ?? null;
};

const buildItem = (
  key: MedicationKey,
  situation: Situation,
  catalog: readonly TestMedicationCatalogEntry[],
): TestPrescriptionItem => {
  const seed = MEDICATIONS[key];
  const live = catalog.find((entry) => entry.name === seed.name);
  const presentations = textList(live?.presentations);
  const routes = routeList(live?.routes);
  const elegida = pickPresentation(presentations, situation.pediatrico);
  const presentation =
    elegida ??
    (situation.pediatrico ? (seed.pediatricPresentation ?? seed.presentation) : seed.presentation);
  const pediatria = situation.pediatrico && seed.pediatricDose !== null;

  return {
    medicationName: seed.name,
    presentation,
    route: routes[0] ?? seed.route,
    dose: pediatria ? (seed.pediatricDose ?? seed.dose) : seed.dose,
    frequency: seed.frequency,
    duration: seed.duration,
    instructions: seed.instructions,
    quantity: pediatria ? (seed.pediatricQuantity ?? seed.quantity) : seed.quantity,
  };
};

/**
 * Medicamentos de la sesión según el perfil y lo que dice el motivo.
 *
 * La regla clínica es la que decide, no el azar: el sano no lleva récipe; el niño
 * solo cuando hay dolor o infección; el alérgico a la penicilina nunca recibe
 * amoxicilina; el anticoagulado, el hipertenso y el diabético no reciben
 * antiinflamatorios no esteroideos. Los demás perfiles llevan al menos el
 * analgésico pautado, que es lo que espera ver el reporte de recetas.
 */
export const buildPrescription = (input: {
  profile: TestClinicalProfile;
  reason: string;
  teeth: readonly number[];
  medications: readonly TestMedicationCatalogEntry[];
}): TestPrescription | null => {
  const pediatrico =
    input.profile === 'pediatrico' || input.teeth.some((tooth) => isPrimaryTooth(tooth));
  const situation = situationOf(input.reason, pediatrico);

  let keys: readonly MedicationKey[];
  switch (input.profile) {
    case 'sano':
      return null;
    case 'pediatrico':
      // Un niño solo lleva récipe cuando hay dolor o infección: no se medica por rutina.
      if (!situation.dolor && !situation.infeccion) return null;
      keys = situation.infeccion ? ['paracetamol', 'amoxicilina'] : ['paracetamol'];
      break;
    case 'caries_multiple':
      keys = situation.infeccion ? ['ibuprofeno', 'amoxicilina'] : ['ibuprofeno'];
      break;
    case 'periodontal':
      keys = situation.dolor ? ['clorhexidina', 'ibuprofeno'] : ['clorhexidina'];
      break;
    case 'diabetes':
    case 'hipertension':
      keys = situation.infeccion ? ['paracetamol', 'amoxicilina'] : ['paracetamol'];
      break;
    case 'alergia_penicilina':
      // La penicilina está contraindicada: el antibiótico, si hace falta, es azitromicina.
      keys = situation.infeccion ? ['paracetamol', 'azitromicina'] : ['paracetamol'];
      break;
    case 'anticoagulado':
      keys = situation.infeccion
        ? ['paracetamol', 'clorhexidina', 'amoxicilina']
        : situation.sangrado
          ? ['paracetamol', 'clorhexidina']
          : ['paracetamol'];
      break;
    case 'edentulo_parcial':
      keys = situation.infeccion
        ? ['paracetamol', 'clorhexidina', 'amoxicilina']
        : situation.sangrado
          ? ['paracetamol', 'clorhexidina']
          : ['paracetamol'];
      break;
    default:
      keys = ['paracetamol'];
  }

  const items = keys.map((key) => buildItem(key, situation, input.medications));
  return {
    generalInstructions: generalInstructionsFor(input.profile, situation, keys),
    items,
  };
};

/** Indicaciones generales del récipe, al pie del documento. */
const generalInstructionsFor = (
  profile: TestClinicalProfile,
  situation: Situation,
  keys: readonly MedicationKey[],
): string => {
  const partes: string[] = [];
  if (keys.includes('clorhexidina')) {
    partes.push(
      'Use el enjuague 30 minutos después del cepillado, sin diluirlo ni enjuagar con agua; no lo use por más de 15 días seguidos.',
    );
  }
  if (situation.pediatrico) {
    partes.push(
      'La dosis del niño se calcula según el peso: consulte al odontólogo antes de repetirla o de combinarla con otro analgésico.',
    );
  }
  switch (profile) {
    case 'anticoagulado':
      partes.push(
        'No suspenda el anticoagulante por su cuenta; mantenga el control con cardiología y acuda de inmediato si el sangrado no cede.',
      );
      break;
    case 'alergia_penicilina':
      partes.push(
        'Recuerde informar en cada consulta su alergia a la penicilina; el récipe no incluye ningún antibiótico de esa familia.',
      );
      break;
    case 'hipertension':
      partes.push(
        'No suspenda su medicación antihipertensiva y avise si presenta dolor de cabeza, mareo o cifras de tensión elevadas.',
      );
      break;
    case 'diabetes':
      partes.push(
        'Mantenga el control de la glicemia y avise si aparece fiebre, mal sabor o supuración en la zona tratada.',
      );
      break;
    case 'pediatrico':
      partes.push(
        'Supervise la toma del medicamento y mantenga el cepillado después de cada comida.',
      );
      break;
    default:
      partes.push('Cumpla el tratamiento completo y asista al control indicado por el odontólogo.');
  }
  return limitar(partes.join(' '), 1500);
};
