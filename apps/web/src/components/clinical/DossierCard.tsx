import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@odontocrm/ui';
import { FileText, History } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { clinicalApi } from '../../lib/endpoints';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { NoticeBanner } from '../NoticeBanner';
import { useNotice } from '../../hooks/useNotice';

/**
 * **Expediente del paciente**: el botón que compone el dossier y la lista de lo ya
 * exportado.
 *
 * Un dossier no se «emite» como un récipe: se **exporta** cuando hace falta —porque el
 * paciente pide su historial o porque se remite a un especialista— y cada exportación
 * queda archivada con su número, su fecha y su huella. La lista permite volver a abrir
 * una sin recomponerla: es el mismo archivo que salió del consultorio, y eso es lo que
 * hace verificable el papel que alguien trae en la mano.
 */
export const DossierCard = ({ patientId }: { patientId: string }) => {
  const { notice, limpiar, exito, error } = useNotice();
  const cliente = useQueryClient();
  const [generando, setGenerando] = useState(false);

  const clave = ['clinica', 'expediente-exportaciones', patientId] as const;

  const exportaciones = useQuery({
    queryKey: clave,
    queryFn: ({ signal }) => clinicalApi.dossiersByPatient(patientId, signal),
    enabled: patientId !== '',
  });

  /** Abre un PDF que ya viene del servidor: objeto local y a una pestaña nueva. */
  const abrir = (blob: Blob): void => {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const generar = useMutation({
    mutationFn: () => clinicalApi.createDossier(patientId),
    onSuccess: (blob) => {
      abrir(blob);
      void cliente.invalidateQueries({ queryKey: clave });
      exito(t('expediente.exito.generado'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
    onSettled: () => setGenerando(false),
  });

  const reabrir = useMutation({
    mutationFn: (id: string) => clinicalApi.downloadDossierPdf(id),
    onSuccess: abrir,
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const items = exportaciones.data?.items ?? [];
  const ocupado = generando || generar.isPending || reabrir.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{t('expediente.titulo')}</CardTitle>
        <p className="text-sm text-ink-muted">{t('expediente.texto')}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <NoticeBanner notice={notice} onClose={limpiar} />

        <Button
          type="button"
          leadingIcon={<FileText className="size-4" />}
          disabled={ocupado}
          onClick={() => {
            setGenerando(true);
            generar.mutate();
          }}
        >
          {ocupado ? t('expediente.generando') : t('expediente.generar')}
        </Button>

        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <History className="size-4" aria-hidden />
            {t('expediente.historial')}
          </p>

          {exportaciones.isLoading && <Spinner label={t('expediente.cargando')} showLabel />}

          {!exportaciones.isLoading && items.length === 0 && (
            <p className="text-sm text-ink-muted">{t('expediente.sinExportaciones')}</p>
          )}

          {items.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="font-mono text-ink">{item.number}</span>
                  <span className="text-ink-muted">{formatDateTime(item.issuedAt)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={ocupado}
                    onClick={() => reabrir.mutate(item.id)}
                  >
                    {t('expediente.abrir')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
