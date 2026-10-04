import {
  clinicalSectionIsComplete,
  type ClinicalRecordDetail,
  type ClinicalSectionKey,
} from '@odontocrm/contracts';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@odontocrm/ui';
import { Check, CircleAlert, CloudUpload, Lock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { clinicalApi } from '../../lib/endpoints';
import {
  CLINICAL_SECTION_FIELDS,
  CLINICAL_SECTION_ORDER,
  clinicalSectionHint,
  clinicalSectionIsRequired,
  clinicalSectionLabel,
  sectionContentFor,
} from '../../lib/clinical';
import { t } from '../../lib/i18n';
import { ClinicalSectionFields } from './ClinicalSectionFields';

const AUTOSAVE_MS = 1_500;

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
      CLINICAL_SECTION_ORDER.map((key) => [key, sectionContentFor(key, record.sections[key])]),
    ),
  );
  const [dirty, setDirty] = useState<ReadonlySet<ClinicalSectionKey>>(new Set());
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const section: ClinicalSectionKey = CLINICAL_SECTION_ORDER[step] ?? 'identificacion';
  const editable = canWrite && record.status === 'borrador';
  const content = drafts[section] ?? {};

  const isDirty = dirty.has(section);

  const completas = useMemo(
    () =>
      new Set(CLINICAL_SECTION_ORDER.filter((key) => clinicalSectionIsComplete(key, drafts[key]))),
    [drafts],
  );

  const guardar = useCallback(
    async (key: ClinicalSectionKey): Promise<void> => {
      setSaveState('saving');
      setError(null);
      try {
        const detail = await clinicalApi.saveSection(record.id, key, drafts[key] ?? {});
        setDirty((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        setSaveState('saved');
        onSaved(detail);
      } catch (caught) {
        setSaveState('idle');
        setError(caught instanceof Error ? caught.message : t('clinica.error.guardar'));
        onError(caught);
      }
    },
    [drafts, onError, onSaved, record.id],
  );

  // Autoguardado: solo la sección activa, y solo si hay cambios sin guardar.
  useEffect(() => {
    if (!editable || !isDirty) return undefined;
    const timer = setTimeout(() => void guardar(section), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [editable, guardar, isDirty, section]);

  const updateField = (name: string, value: unknown): void => {
    setDrafts((current) => ({
      ...current,
      [section]: { ...(current[section] ?? {}), [name]: value },
    }));
    setDirty((current) => new Set(current).add(section));
    setSaveState('idle');
  };

  const irA = (index: number): void => {
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

          <ClinicalSectionFields
            fields={CLINICAL_SECTION_FIELDS[section]}
            content={content}
            disabled={!editable}
            onChange={updateField}
          />
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
                disabled={!isDirty}
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
