import {
  CLINICAL_STATE_COLORS,
  PROSTHESIS_ARCH_LABELS,
  PROSTHESIS_KIND_LABELS,
  prosthesisSummaryLabel,
  type ClinicalState,
  type ProsthesisArch,
  type ProsthesisKind,
  type ProsthesisRecord,
} from '@odontocrm/contracts';
import { Alert, Button, Dialog } from '@odontocrm/ui';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { t } from '../../lib/i18n';
import { odontogramApi } from '../../lib/odontogram-api';

/**
 * Ficha de una **prótesis removible** (PPR/PRT).
 *
 * Áreas de ≥ 44 px, como la hoja de la pieza: el tipo y la arcada los trae el borrador
 * (de dónde se abrió), y aquí se elige el **estado** —indicada (rojo) o instalada
 * (azul)— y se añaden observaciones. Guarda con `recordProsthesis` (clave tipo +
 * arcada: la PRT se normaliza a la arcada completa en el servidor) y permite eliminar
 * una existente.
 */

const TEXTAREA_CLASSES =
  'w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted';

export interface ProsthesisDialogProps {
  open: boolean;
  patientId: string;
  /** Tipo y arcada los fija quien abre la ficha (borrador del gráfico). */
  kind: ProsthesisKind;
  arch: ProsthesisArch;
  /** Piezas del tramo (PPR) o de la arcada completa (PRT). */
  toothNumbers: readonly number[];
  /** Prótesis ya registrada que se está editando (si la hay). */
  existing: ProsthesisRecord | null;
  canWrite: boolean;
  sessionId?: string | null;
  onClose: () => void;
  onApplied: (cambio: { descripcion: string }) => void;
  onError: (mensaje: string) => void;
}

/** Resumen legible del tramo: `PPR 14–16` o `PRT Maxilar superior`. */
const resumen = (
  kind: ProsthesisKind,
  arch: ProsthesisArch,
  toothNumbers: readonly number[],
): string => {
  const orden = [...toothNumbers].sort((a, b) => a - b);
  const desde = orden[0];
  const hasta = orden[orden.length - 1];
  const base = PROSTHESIS_KIND_LABELS[kind];
  if (kind === 'prt') return `${base} · ${PROSTHESIS_ARCH_LABELS[arch]}`;
  return desde === undefined || hasta === undefined
    ? base
    : `${base} · ${PROSTHESIS_ARCH_LABELS[arch]} (${String(desde)}–${String(hasta)})`;
};

export const ProsthesisDialog = ({
  open,
  patientId,
  kind,
  arch,
  toothNumbers,
  existing,
  canWrite,
  sessionId = null,
  onClose,
  onApplied,
  onError,
}: ProsthesisDialogProps) => {
  const [estado, setEstado] = useState<ClinicalState>('pendiente');
  const [notas, setNotas] = useState('');
  const [ocupada, setOcupada] = useState(false);

  // Al abrir (o cambiar de prótesis) la ficha arranca del estado guardado o de indicada.
  useEffect(() => {
    if (!open) return;
    setEstado(existing?.state ?? 'pendiente');
    setNotas(existing?.notes ?? '');
  }, [open, existing, kind, arch]);

  const guardar = async (): Promise<void> => {
    setOcupada(true);
    try {
      await odontogramApi.recordProsthesis(patientId, {
        kind,
        arch,
        toothNumbers: [...toothNumbers],
        state: estado,
        notes: notas.trim() === '' ? null : notas.trim(),
        sessionId,
      });
      onApplied({
        descripcion: prosthesisSummaryLabel({
          id: existing?.id ?? '',
          kind,
          arch,
          toothNumbers: [...toothNumbers],
          state: estado,
          notes: null,
          recordedByUsername: null,
          recordedAt: '',
          updatedAt: '',
          sessionId: null,
        }),
      });
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setOcupada(false);
    }
  };

  const eliminar = async (): Promise<void> => {
    if (existing === null) return;
    setOcupada(true);
    try {
      await odontogramApi.removeProsthesis(patientId, existing.id);
      onApplied({ descripcion: prosthesisSummaryLabel(existing) });
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setOcupada(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('odonto.protesis.titulo')}
      footer={
        <>
          {canWrite && existing !== null && (
            <Button
              variant="ghost"
              disabled={ocupada}
              onClick={() => void eliminar()}
              leadingIcon={<Trash2 className="size-4" aria-hidden />}
            >
              {t('odonto.protesis.eliminar')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={ocupada}>
            {t('comun.cancelar')}
          </Button>
          {canWrite && (
            <Button loading={ocupada} onClick={() => void guardar()}>
              {t('odonto.protesis.guardar')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-ink-muted">{resumen(kind, arch, toothNumbers)}</p>

        {existing !== null && (
          <Alert variant="info">{t('odonto.protesis.existente')}</Alert>
        )}

        {/* Estado: indicada (rojo) o instalada (azul), a botones grandes. */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            {t('odonto.protesis.estado')}
          </h4>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={estado === 'pendiente'}
              disabled={!canWrite}
              onClick={() => setEstado('pendiente')}
              className={`flex min-h-11 items-center justify-center gap-2 rounded-control border px-3 py-2 text-sm font-medium transition-colors ${
                estado === 'pendiente'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-ink-muted hover:text-ink'
              }`}
            >
              <span
                className="inline-block size-3 rounded-full"
                style={{ backgroundColor: CLINICAL_STATE_COLORS.pendiente }}
                aria-hidden
              />
              {t('odonto.protesis.indicada')}
            </button>
            <button
              type="button"
              aria-pressed={estado === 'completado'}
              disabled={!canWrite}
              onClick={() => setEstado('completado')}
              className={`flex min-h-11 items-center justify-center gap-2 rounded-control border px-3 py-2 text-sm font-medium transition-colors ${
                estado === 'completado'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-ink-muted hover:text-ink'
              }`}
            >
              <span
                className="inline-block size-3 rounded-full"
                style={{ backgroundColor: CLINICAL_STATE_COLORS.completado }}
                aria-hidden
              />
              {t('odonto.protesis.instalada')}
            </button>
          </div>
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            {t('odonto.protesis.notas')}
          </h4>
          <textarea
            className={`${TEXTAREA_CLASSES} mt-2`}
            value={notas}
            onChange={(event) => setNotas(event.target.value)}
            rows={2}
            maxLength={500}
            disabled={!canWrite}
            aria-label={t('odonto.protesis.notas')}
            placeholder={t('odonto.protesis.notasPlaceholder')}
          />
        </section>
      </div>
    </Dialog>
  );
};
