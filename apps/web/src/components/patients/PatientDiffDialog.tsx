import { SENSITIVE_PATIENT_FIELDS } from '@odontocrm/contracts';
import { Badge, Button, Dialog } from '@odontocrm/ui';
import { ArrowRight, ShieldAlert } from 'lucide-react';

import { PATIENT_FIELD_LABELS, t } from '../../lib/i18n';
import type { ChangeSummary } from '../../lib/patients';

export interface PatientDiffDialogProps {
  open: boolean;
  resumen: ChangeSummary | null;
  motivo: string;
  guardando: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

const CAMPOS_SENSIBLES: ReadonlySet<string> = new Set<string>(SENSITIVE_PATIENT_FIELDS);

const etiquetaDe = (field: string): string => {
  const [raiz, hijo] = field.split('.');
  if (raiz === undefined) return field;
  if (raiz === 'guardian') {
    if (hijo === 'fullName') return t('pacientes.form.guardianNombre');
    if (hijo === 'relationship') return t('pacientes.form.guardianParentesco');
    if (hijo === 'phone') return t('pacientes.form.guardianTelefono');
    if (hijo === 'docNumber' || hijo === 'docType') return t('pacientes.form.guardianDocumento');
    return t('pacientes.campo.guardian');
  }
  return PATIENT_FIELD_LABELS[raiz] ?? raiz;
};

const esSensible = (field: string): boolean => CAMPOS_SENSIBLES.has(field.split('.')[0] ?? '');

/**
 * Confirmación del cambio: enseña campo por campo el valor anterior y el nuevo
 * antes de enviar el `PATCH`, y destaca los datos sensibles (los que quedan en
 * la auditoría con el motivo). El envío del `PATCH` solo ocurre desde aquí.
 */
export const PatientDiffDialog = ({
  open,
  resumen,
  motivo,
  guardando,
  error,
  onClose,
  onConfirm,
}: PatientDiffDialogProps) => {
  const cambios = resumen?.changes ?? [];
  const sensibles = resumen?.sensitive ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissOnBackdrop={!guardando}
      title={t('pacientes.confirmar.titulo')}
      description={t('pacientes.confirmar.texto')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={guardando}>
            {t('comun.cancelar')}
          </Button>
          <Button onClick={onConfirm} loading={guardando} loadingLabel={t('comun.guardando')}>
            {t('pacientes.confirmar.enviar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}

        <p className="text-xs text-ink-subtle">
          {t('pacientes.confirmar.total', { total: cambios.length })}
        </p>

        <ul className="divide-y divide-border overflow-hidden rounded-control border border-border">
          {cambios.map((cambio) => (
            <li key={cambio.field} className="grid gap-1 px-3.5 py-3 sm:grid-cols-[12rem_1fr]">
              <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                {etiquetaDe(cambio.field)}
                {esSensible(cambio.field) && (
                  <Badge
                    variant="warning"
                    icon={<ShieldAlert className="size-3" aria-hidden="true" />}
                  >
                    {t('pacientes.sensible')}
                  </Badge>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-muted line-through">{cambio.before}</span>
                <ArrowRight className="size-3.5 text-ink-subtle" aria-hidden="true" />
                <span className="font-medium text-ink">{cambio.after}</span>
              </span>
            </li>
          ))}
        </ul>

        {sensibles.length > 0 && (
          <p className="text-xs font-medium text-warning">{t('pacientes.confirmar.sensibles')}</p>
        )}

        <div className="rounded-control border border-border bg-surface-muted px-3.5 py-3">
          <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            {t('pacientes.confirmar.motivo')}
          </p>
          <p className="text-sm text-ink">{motivo}</p>
        </div>
      </div>
    </Dialog>
  );
};
