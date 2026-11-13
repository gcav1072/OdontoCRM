import {
  clinicalSectionIsComplete,
  syncPlanWithDiagnosis,
  type ClinicalEvolutionSessionSummary,
  type ClinicalRecordDetail,
  type ClinicalSectionKey,
} from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
} from '@odontocrm/ui';
import { Check, CircleAlert, CloudUpload, Lock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clinicalApi } from '../../lib/endpoints';
import {
  CLINICAL_SECTION_FIELDS,
  CLINICAL_SECTION_ORDER,
  asDiagnosisItems,
  clinicalSectionHint,
  clinicalSectionIsRequired,
  clinicalSectionLabel,
  sectionContentFor,
} from '../../lib/clinical';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { ClinicalSectionFields, asProcedures } from './ClinicalSectionFields';

const AUTOSAVE_MS = 1_500;

/** Mínimo de texto que exigen los esquemas de diagnóstico y plan al firmar/guardar. */
const TEXTO_MINIMO = 3;

/**
 * ¿El borrador tiene descripciones que todavía no se pueden enviar? Un texto de
 * 1 o 2 caracteres no valida (el diagnóstico exige 3 para guardarse) y el
 * autoguardado espera a que el médico termine de escribirlo.
 */
const tieneDescripcionesCortas = (
  key: ClinicalSectionKey,
  content: Record<string, unknown> | undefined,
): boolean => {
  if (content === undefined) return false;
  if (key === 'diagnostico') {
    return asDiagnosisItems(content['items']).some((item) => {
      const text = item.descripcion.trim();
      // La descripción es obligatoria: una fila con piezas pero sin descripción no
      // valida en el servidor. Las filas totalmente vacías (sin texto ni piezas) sí
      // se ignoran: se omiten al serializar y no bloquean el autoguardado.
      if (text.length === 0) return (item.piezas ?? '').trim() !== '';
      return text.length < TEXTO_MINIMO;
    });
  }
  if (key === 'plan_tratamiento') {
    return asProcedures(content['procedimientos']).some((row) => {
      const text = row.descripcion.trim();
      return text.length > 0 && text.length < TEXTO_MINIMO;
    });
  }
  return false;
};

/**
 * Contenido de diagnóstico que viaja al servidor: las filas nuevas que quedaron
 * completamente vacías (sin descripción ni piezas) no se envían. El resto de
 * campos del borrador se conserva tal cual.
 */
const diagnosticoParaGuardar = (
  content: Record<string, unknown> | undefined,
): Record<string, unknown> => ({
  ...(content ?? {}),
  items: asDiagnosisItems(content?.['items']).filter(
    (item) => item.descripcion.trim() !== '' || (item.piezas ?? '').trim() !== '',
  ),
});

/** Resumen automático de las sesiones cerradas (cambio 4): se lee del servidor. */
const EvolutionSessionsSummary = ({
  sessions,
}: {
  sessions: readonly ClinicalEvolutionSessionSummary[];
}) => (
  <section
    aria-labelledby="clinica-evolucion-sesiones"
    className="mb-6 rounded-control border border-border bg-surface-muted/40 p-4"
  >
    <h4 id="clinica-evolucion-sesiones" className="text-sm font-semibold text-ink">
      {t('clinica.evolucion.resumen.titulo')}
    </h4>
    <p className="mt-0.5 text-sm text-ink-muted">{t('clinica.evolucion.resumen.ayuda')}</p>

    {sessions.length === 0 ? (
      <p className="mt-3 text-sm text-ink-subtle">{t('clinica.evolucion.sinSesiones')}</p>
    ) : (
      <ul className="mt-3 space-y-3">
        {sessions.map((session) => (
          <li key={session.id} className="rounded-control border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info">
                {t('clinica.evolucion.sesionNumero', { numero: session.sessionNumber })}
              </Badge>
              <span className="text-sm text-ink-muted">{formatDateTime(session.fecha)}</span>
            </div>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="grid grid-cols-[7rem_1fr] gap-2">
                <dt className="text-ink-muted">{t('clinica.evolucion.diagnostico')}</dt>
                <dd className="whitespace-pre-wrap">
                  {session.diagnostico ?? t('clinica.evolucion.sinDiagnostico')}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_1fr] gap-2">
                <dt className="text-ink-muted">{t('clinica.evolucion.tratamientos')}</dt>
                <dd>
                  {session.tratamientos.length === 0 ? (
                    t('clinica.evolucion.sinTratamientos')
                  ) : (
                    <ul className="list-inside list-disc">
                      {session.tratamientos.map((tratamiento, index) => (
                        <li key={`${session.id}-${index}`}>{tratamiento}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
              {session.observaciones !== null && session.observaciones.trim() !== '' && (
                <div className="grid grid-cols-[7rem_1fr] gap-2">
                  <dt className="text-ink-muted">{t('clinica.evolucion.observaciones')}</dt>
                  <dd className="whitespace-pre-wrap">{session.observaciones}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>
    )}
  </section>
);

export interface MedicalRecordFormProps {
  record: ClinicalRecordDetail;
  canWrite: boolean;
  onSaved: (detail: ClinicalRecordDetail) => void;
  onError: (error: unknown) => void;
}

type SaveState = 'idle' | 'saving' | 'saved';

/**
 * Formulario por pasos de la historia clínica.
 *
 * Cada sección se guarda por su cuenta (borrador con autoguardado a los 1,5 s y
 * botón manual), así que una historia se puede llenar en varias sentadas sin
 * perder nada. Cuando la historia está `firmada` el formulario queda bloqueado:
 * las correcciones se hacen con adendas.
 *
 * El diagnóstico y el plan van **acoplados** (v1.2): cada alta/baja de un ítem
 * de diagnóstico se refleja en el acto en el borrador del plan con
 * `syncPlanWithDiagnosis` (la misma función pura que usa el servidor), de modo
 * que si el doctor pulsa «Siguiente» al instante sus diagnósticos ya tienen su
 * procedimiento listo para completar.
 */
export const MedicalRecordForm = ({
  record,
  canWrite,
  onSaved,
  onError,
}: MedicalRecordFormProps) => {
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>(() =>
    Object.fromEntries(
      CLINICAL_SECTION_ORDER.map((key) => {
        const content = sectionContentFor(key, record.sections[key]);
        // El plan arranca ya sincronizado con el diagnóstico guardado: la
        // relación ítem ↔ procedimiento es la misma que mantiene el servidor.
        return [
          key,
          key === 'plan_tratamiento'
            ? syncPlanWithDiagnosis(record.sections['diagnostico'], content)
            : content,
        ];
      }),
    ),
  );
  const [dirty, setDirty] = useState<ReadonlySet<ClinicalSectionKey>>(() => new Set());
  // Espejo síncrono de `dirty`: al volver la respuesta del servidor hay que saber
  // si el médico tocó el plan mientras tanto antes de pisar su borrador.
  const dirtyRef = useRef<ReadonlySet<ClinicalSectionKey>>(dirty);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const section: ClinicalSectionKey = CLINICAL_SECTION_ORDER[step] ?? 'identificacion';
  const editable = canWrite && record.status === 'borrador';
  const content = drafts[section] ?? {};
  // Se lee siempre de las props del servidor (nunca se congela en `drafts`): una
  // sesión recién cerrada tiene que aparecer sin recargar la página.
  const evolutionSessions = record.evolutionSessions ?? [];

  const isDirty = dirty.has(section);

  const cambiarDirty = useCallback(
    (updater: (current: ReadonlySet<ClinicalSectionKey>) => ReadonlySet<ClinicalSectionKey>) => {
      setDirty((current) => {
        const next = updater(current);
        dirtyRef.current = next;
        return next;
      });
    },
    [],
  );

  const diagnosisItems = useMemo(
    () => asDiagnosisItems(drafts['diagnostico']?.['items']),
    [drafts],
  );
  const planProcedures = useMemo(
    () => asProcedures(drafts['plan_tratamiento']?.['procedimientos']),
    [drafts],
  );

  const completas = useMemo(
    () =>
      new Set(CLINICAL_SECTION_ORDER.filter((key) => clinicalSectionIsComplete(key, drafts[key]))),
    [drafts],
  );

  const pendientePorTexto = tieneDescripcionesCortas(section, drafts[section]);
  // El plan no se puede guardar antes que un diagnóstico con cambios: sus ítems
  // son la fuente de los enlaces y el servidor descarta los procedimientos
  // huérfanos (los que apuntan a un diagnóstico que aún no está en BD).
  const diagnosticoPendiente =
    dirty.has('diagnostico') && tieneDescripcionesCortas('diagnostico', drafts['diagnostico']);
  const planBloqueadoPorDiagnostico = section === 'plan_tratamiento' && diagnosticoPendiente;
  const guardadoBloqueado = pendientePorTexto || planBloqueadoPorDiagnostico;

  /**
   * Tras guardar, el plan del servidor manda salvo que el médico lo esté editando.
   * La sincronización se calcula contra el **diagnóstico local vigente**: los
   * procedimientos de ítems que aún no se han podido guardar (una fila nueva
   * vacía) siguen viéndose pendientes en pantalla y no desaparecen al vuelo.
   */
  const aplicarPlanDelServidor = useCallback((detail: ClinicalRecordDetail): void => {
    setDrafts((current) => {
      if (dirtyRef.current.has('plan_tratamiento')) return current;
      const plan = sectionContentFor('plan_tratamiento', detail.sections['plan_tratamiento']);
      return {
        ...current,
        plan_tratamiento: syncPlanWithDiagnosis(current['diagnostico'], plan),
      };
    });
  }, []);

  /** Guarda una sección concreta. Devuelve `false` si el servidor la rechazó. */
  const guardarSeccion = useCallback(
    async (key: ClinicalSectionKey): Promise<boolean> => {
      setSaveState('saving');
      setError(null);
      const contenido =
        key === 'diagnostico' ? diagnosticoParaGuardar(drafts[key]) : (drafts[key] ?? {});
      try {
        const detail = await clinicalApi.saveSection(record.id, key, contenido);
        cambiarDirty((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        setSaveState('saved');
        onSaved(detail);
        aplicarPlanDelServidor(detail);
        return true;
      } catch (caught) {
        setSaveState('idle');
        setError(caught instanceof Error ? caught.message : t('clinica.error.guardar'));
        onError(caught);
        return false;
      }
    },
    [aplicarPlanDelServidor, cambiarDirty, drafts, onError, onSaved, record.id],
  );

  const guardar = useCallback(
    async (key: ClinicalSectionKey): Promise<void> => {
      // No se lanza la petición: el aviso en pantalla explica qué falta.
      if (tieneDescripcionesCortas(key, drafts[key])) {
        setSaveState('idle');
        return;
      }
      if (
        key === 'plan_tratamiento' &&
        dirtyRef.current.has('diagnostico') &&
        !tieneDescripcionesCortas('diagnostico', drafts['diagnostico'])
      ) {
        const guardado = await guardarSeccion('diagnostico');
        if (!guardado) return;
      }
      await guardarSeccion(key);
    },
    [drafts, guardarSeccion],
  );

  // Autoguardado: solo la sección activa, si hay cambios y el texto ya valida.
  useEffect(() => {
    if (!editable || !isDirty || guardadoBloqueado) return undefined;
    const timer = setTimeout(() => void guardar(section), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [editable, guardar, guardadoBloqueado, isDirty, section]);

  const updateField = (name: string, value: unknown): void => {
    setDrafts((current) => {
      const actual = current[section] ?? {};
      const siguiente = { ...actual, [name]: value };
      if (section !== 'diagnostico') {
        return { ...current, [section]: siguiente };
      }
      // Diagnóstico → plan en tiempo real: el contrato decide qué procedimientos
      // existen (conserva lo escrito y la pieza la manda el diagnóstico).
      return {
        ...current,
        diagnostico: siguiente,
        plan_tratamiento: syncPlanWithDiagnosis(siguiente, current['plan_tratamiento']),
      };
    });
    cambiarDirty((current) => new Set(current).add(section));
    setSaveState('idle');
  };

  const irA = (index: number): void => {
    const saliente = CLINICAL_SECTION_ORDER[step];
    // Al cambiar de paso no se espera el temporizador: si la sección que se deja
    // tiene cambios válidos se guarda de inmediato.
    if (
      editable &&
      saliente !== undefined &&
      dirty.has(saliente) &&
      !tieneDescripcionesCortas(saliente, drafts[saliente]) &&
      !(saliente === 'plan_tratamiento' && diagnosticoPendiente)
    ) {
      void guardar(saliente);
    }
    setStep(index);
    setError(null);
  };

  return (
    <Card>
      <CardHeader className="flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{t('clinica.form.titulo')}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">
            {t('clinica.form.paso', { actual: step + 1, total: CLINICAL_SECTION_ORDER.length })} ·{' '}
            {CLINICAL_SECTION_ORDER.filter((key) => completas.has(key)).length}/
            {CLINICAL_SECTION_ORDER.length} {t('clinica.form.completas')}
          </p>
        </div>
        <Badge variant={record.status === 'firmada' ? 'success' : 'info'}>
          {t(record.status === 'firmada' ? 'clinica.estado.firmada' : 'clinica.estado.borrador')}
        </Badge>
      </CardHeader>

      <CardContent>
        <nav aria-label={t('clinica.form.secciones')} className="mb-5 flex flex-wrap gap-2">
          {CLINICAL_SECTION_ORDER.map((key, index) => {
            const activa = index === step;
            const completa = completas.has(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => irA(index)}
                aria-current={activa ? 'step' : undefined}
                className={[
                  'inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  activa
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-muted',
                ].join(' ')}
              >
                {completa ? (
                  <Check className="size-3.5 text-success" aria-hidden />
                ) : (
                  <span
                    aria-hidden
                    className="inline-block size-3.5 rounded-full border border-border-strong"
                  />
                )}
                {clinicalSectionLabel(key)}
                {clinicalSectionIsRequired(key) && <span aria-hidden>*</span>}
              </button>
            );
          })}
        </nav>

        {!editable && (
          <div className="mb-5 flex items-start gap-2 rounded-control border border-border bg-surface-muted px-3 py-2.5 text-sm text-ink-muted">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              {record.status === 'firmada'
                ? t('clinica.form.bloqueada')
                : t('clinica.form.soloLectura')}
            </p>
          </div>
        )}

        <section aria-labelledby="clinica-seccion-titulo">
          <h3 id="clinica-seccion-titulo" className="text-base font-semibold text-ink">
            {clinicalSectionLabel(section)}
            {clinicalSectionIsRequired(section) && (
              <span className="ml-1 text-danger" title={t('clinica.form.obligatoria')}>
                *
              </span>
            )}
          </h3>
          <p className="mt-0.5 mb-4 text-sm text-ink-muted">{clinicalSectionHint(section)}</p>

          {section === 'evolucion' && <EvolutionSessionsSummary sessions={evolutionSessions} />}

          <ClinicalSectionFields
            fields={CLINICAL_SECTION_FIELDS[section]}
            content={content}
            disabled={!editable}
            onChange={updateField}
            diagnosisItems={diagnosisItems}
            planProcedures={planProcedures}
          />

          {editable && guardadoBloqueado && (
            <Alert variant="warning" className="mt-4">
              {pendientePorTexto
                ? section === 'diagnostico'
                  ? t('clinica.diagnostico.avisoCorto')
                  : t('clinica.plan.avisoCorto')
                : t('clinica.plan.diagnosticoPendiente')}
            </Alert>
          )}
        </section>

        {error !== null && (
          <p role="alert" className="mt-4 text-sm font-medium text-danger">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="flex items-center gap-3 text-sm text-ink-muted">
            {editable && saveState === 'saving' && (
              <span className="inline-flex items-center gap-2">
                <Spinner size="sm" /> {t('clinica.form.guardando')}
              </span>
            )}
            {editable && saveState === 'saved' && !isDirty && (
              <span className="inline-flex items-center gap-2 text-success">
                <Check className="size-4" aria-hidden /> {t('clinica.form.guardado')}
              </span>
            )}
            {editable && isDirty && saveState !== 'saving' && (
              <span className="inline-flex items-center gap-2 text-warning">
                <CircleAlert className="size-4" aria-hidden /> {t('clinica.form.sinGuardar')}
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={step === 0}
              onClick={() => irA(step - 1)}
            >
              {t('clinica.form.anterior')}
            </Button>
            {editable && (
              <Button
                type="button"
                variant="secondary"
                disabled={!isDirty || guardadoBloqueado}
                loading={saveState === 'saving'}
                leadingIcon={<CloudUpload className="size-4" aria-hidden />}
                onClick={() => void guardar(section)}
              >
                {t('clinica.form.guardarBorrador')}
              </Button>
            )}
            <Button
              type="button"
              disabled={step === CLINICAL_SECTION_ORDER.length - 1}
              onClick={() => irA(step + 1)}
            >
              {t('clinica.form.siguiente')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
