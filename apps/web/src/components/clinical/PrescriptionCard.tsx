import {
  formatPrescriptionNumber,
  prescriptionStatusLabel,
  type PrescriptionSummary,
} from '@odontocrm/contracts';
import { useMutation } from '@tanstack/react-query';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@odontocrm/ui';
import { FileDown, FilePlus2, Printer } from 'lucide-react';
import { useState } from 'react';

import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import { clinicalApi } from '../../lib/endpoints';
import { formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { NoticeBanner } from '../NoticeBanner';

/**
 * Los récipes del paciente (o de la sesión): número, estado, PDF archivado y las
 * acciones —descargar, imprimir y **anular con motivo**—.
 *
 * Descargar e imprimir dejan constancia (`printCount`): reimprimir un récipe es un
 * acto que queda en la auditoría ([ADR 0015](../../../../../docs/adr/0015-recipe-a5-en-pdf.md)).
 */

const variantPorEstado = (status: string): 'success' | 'info' | 'danger' =>
  status === 'emitida' ? 'success' : status === 'anulada' ? 'danger' : 'info';

export interface PrescriptionCardProps {
  prescriptions: readonly PrescriptionSummary[];
  loading?: boolean;
  canWrite: boolean;
  /** Abre el editor para preparar uno nuevo (solo si la sesión no tiene uno emitido). */
  onNew?: (() => void) | undefined;
  onChanged: () => void;
}

export const PrescriptionCard = ({
  prescriptions,
  loading = false,
  canWrite,
  onNew,
  onChanged,
}: PrescriptionCardProps) => {
  const { notice, limpiar, exito, error } = useNotice();
  const [descargando, setDescargando] = useState<string | null>(null);
  const [anulando, setAnulando] = useState<PrescriptionSummary | null>(null);
  const [motivo, setMotivo] = useState('');

  const descargar = async (prescription: PrescriptionSummary): Promise<void> => {
    setDescargando(prescription.id);
    try {
      const blob = await clinicalApi.downloadPrescriptionPdf(prescription.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      await clinicalApi.registerPrescriptionPrint(prescription.id);
      onChanged();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (fallo) {
      error(apiErrorMessage(fallo));
    } finally {
      setDescargando(null);
    }
  };

  const anular = useMutation({
    mutationFn: (entrada: { id: string; reason: string }) =>
      clinicalApi.annulPrescription(entrada.id, { reason: entrada.reason }),
    onSuccess: () => {
      setAnulando(null);
      setMotivo('');
      onChanged();
      exito(t('clinica.recipe.exito.anulado'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const emitidos = prescriptions.filter((item) => item.number !== null);

  return (
    <Card>
      <CardHeader className="flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{t('clinica.recipe.lista.titulo')}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">{t('clinica.recipe.lista.texto')}</p>
        </div>
        {canWrite && onNew !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<FilePlus2 className="size-4" aria-hidden />}
            onClick={onNew}
          >
            {t('clinica.recipe.lista.nuevo')}
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

        {loading && <Spinner showLabel label={t('comun.cargando')} />}

        {!loading && emitidos.length === 0 && (
          <p className="text-sm text-ink-muted">{t('clinica.recipe.lista.vacio')}</p>
        )}

        {emitidos.length > 0 && (
          <ul className="divide-y divide-border rounded-control border border-border">
            {emitidos.map((prescription) => (
              <li
                key={prescription.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {prescription.number ??
                      formatPrescriptionNumber(prescription.prescriptionNumber ?? 0)}
                    {prescription.issuedAt === null
                      ? ''
                      : ` · ${formatDate(prescription.issuedAt)}`}
                  </p>
                  <p className="text-xs text-ink-subtle">
                    {t('clinica.recipe.lista.medicamentos', { total: prescription.itemCount })}
                    {prescription.printCount > 0
                      ? ` · ${t('clinica.recipe.lista.impresiones', { veces: prescription.printCount })}`
                      : ''}
                    {prescription.annulReason === null ? '' : ` · ${prescription.annulReason}`}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={variantPorEstado(prescription.status)}>
                    {prescriptionStatusLabel(prescription.status)}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={descargando === prescription.id}
                    leadingIcon={<FileDown className="size-4" aria-hidden />}
                    onClick={() => void descargar(prescription)}
                  >
                    {t('clinica.recipe.descargar')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<Printer className="size-4" aria-hidden />}
                    onClick={() => void descargar(prescription)}
                  >
                    {t('clinica.recipe.imprimir')}
                  </Button>
                  {canWrite && prescription.status === 'emitida' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAnulando(prescription);
                        setMotivo('');
                      }}
                    >
                      {t('clinica.recipe.anular')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {anulando !== null && (
          <div className="rounded-control border border-danger/40 bg-danger/5 p-3">
            <p className="text-sm font-medium text-ink">
              {t('clinica.recipe.anularTitulo', { numero: anulando.number ?? '' })}
            </p>
            <input
              className="mt-2 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
              placeholder={t('clinica.recipe.motivoAnulacionPlaceholder')}
              value={motivo}
              onChange={(evento) => setMotivo(evento.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={anular.isPending}
                disabled={motivo.trim().length < 3}
                onClick={() => anular.mutate({ id: anulando.id, reason: motivo.trim() })}
              >
                {t('clinica.recipe.confirmarAnulacion')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAnulando(null)}>
                {t('comun.cancelar')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
