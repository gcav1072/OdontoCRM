import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Spinner } from '@odontocrm/ui';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { OdontogramDocument } from '../components/odontogram/OdontogramDocument';
import { apiErrorMessage } from '../lib/api';
import { t } from '../lib/i18n';
import { odontogramApi } from '../lib/odontogram-api';

/** Tope del histórico en el informe: el máximo que admite el servicio (500). */
const LIMITE_HISTORIAL = 500;

/**
 * Vista de impresión del odontograma: se abre en una pestaña propia (fuera del
 * shell, para que el papel no lleve navegación) y la comparte la secretaría, que
 * **imprime pero no escribe** (decisión 23).
 *
 * Cada impresión deja constancia en la auditoría con su actor; si esa llamada
 * falla, la impresión sale igual: primero está el papel.
 *
 * La casilla del historial es opt-in: el informe normal se queda corto y legible, y
 * el que se archiva o se entrega puede llevar detrás la evolución con sus fechas.
 */
export const OdontogramPrintPage = () => {
  const { patientId } = useParams<{ patientId: string }>();
  const [aviso, setAviso] = useState<string | null>(null);
  const [conHistorial, setConHistorial] = useState(false);

  const odontogramaQuery = useQuery({
    queryKey: ['odontograma', patientId],
    queryFn: ({ signal }) => odontogramApi.byPatient(patientId ?? '', signal),
    enabled: patientId !== undefined && patientId !== '',
  });

  const historialQuery = useQuery({
    queryKey: ['odontograma', 'historial', patientId, LIMITE_HISTORIAL],
    queryFn: ({ signal }) => odontogramApi.history(patientId ?? '', signal, LIMITE_HISTORIAL),
    enabled: patientId !== undefined && patientId !== '' && conHistorial,
  });

  const registrarImpresion = useMutation({
    mutationFn: () => odontogramApi.registerPrint(patientId ?? ''),
  });

  const imprimir = async (): Promise<void> => {
    setAviso(null);
    try {
      await registrarImpresion.mutateAsync();
    } catch (fallo) {
      setAviso(apiErrorMessage(fallo));
    }
    window.print();
  };

  if (patientId === undefined || patientId === '') {
    return <Alert variant="danger">{t('odonto.error.sinPaciente')}</Alert>;
  }

  if (odontogramaQuery.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner size="lg" showLabel label={t('comun.cargando')} />
      </div>
    );
  }

  if (odontogramaQuery.isError || odontogramaQuery.data === undefined) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Alert variant="danger" title={t('odonto.error.titulo')}>
          {apiErrorMessage(odontogramaQuery.error)}
        </Alert>
      </div>
    );
  }

  const resultado = odontogramaQuery.data;

  /**
   * Sin odontograma no hay nada que imprimir: imprimir una boca «sana» que nadie
   * ha explorado sería un documento engañoso, así que se dice tal cual.
   */
  if (!resultado.exists) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Alert variant="warning" title={t('odonto.error.titulo')}>
          {t('odonto.hallazgos.ninguno')}
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas pb-10">
      <div className="mx-auto flex max-w-[21cm] flex-wrap items-center justify-between gap-3 px-6 py-4 print:hidden">
        <div className="flex items-center gap-2 text-ink-muted">
          <Printer className="size-4" aria-hidden />
          <span className="text-sm">{t('odonto.imprimir.titulo')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* La casilla decide si el papel lleva detrás la evolución con sus fechas. */}
          <Checkbox
            checked={conHistorial}
            onChange={(event) => setConHistorial(event.target.checked)}
            label={t('odonto.imprimir.conHistorial')}
          />
          <Button variant="secondary" onClick={() => window.close()}>
            {t('comun.cerrar')}
          </Button>
          <Button loading={registrarImpresion.isPending} onClick={() => void imprimir()}>
            {t('odonto.imprimir.accion')}
          </Button>
        </div>
      </div>

      {aviso !== null && (
        <div className="mx-auto max-w-[21cm] px-6 print:hidden">
          <Alert variant="warning">{aviso}</Alert>
        </div>
      )}

      {/* Si se pidió el historial y todavía no llegó, se dice: imprimir sin él sería
          entregar un informe distinto del que se pidió. */}
      {conHistorial && historialQuery.isLoading && (
        <div className="mx-auto max-w-[21cm] px-6 pb-3 print:hidden">
          <Spinner size="sm" showLabel label={t('odonto.imprimir.historial.cargando')} />
        </div>
      )}
      {conHistorial && historialQuery.isError && (
        <div className="mx-auto max-w-[21cm] px-6 pb-3 print:hidden">
          <Alert variant="warning">{apiErrorMessage(historialQuery.error)}</Alert>
        </div>
      )}

      <OdontogramDocument
        detail={resultado.odontogram}
        history={conHistorial ? (historialQuery.data?.entries ?? []) : null}
        historyLimit={LIMITE_HISTORIAL}
      />
    </div>
  );
};
