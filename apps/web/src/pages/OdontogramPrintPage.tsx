import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Spinner } from '@odontocrm/ui';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { OdontogramDocument } from '../components/odontogram/OdontogramDocument';
import { apiErrorMessage } from '../lib/api';
import { t } from '../lib/i18n';
import { odontogramApi } from '../lib/odontogram-api';

/**
 * Vista de impresión del odontograma: se abre en una pestaña propia (fuera del
 * shell, para que el papel no lleve navegación) y la comparte la secretaría, que
 * **imprime pero no escribe** (decisión 23).
 *
 * Cada impresión deja constancia en la auditoría con su actor; si esa llamada
 * falla, la impresión sale igual: primero está el papel.
 */
export const OdontogramPrintPage = () => {
  const { patientId } = useParams<{ patientId: string }>();
  const [aviso, setAviso] = useState<string | null>(null);

  const odontogramaQuery = useQuery({
    queryKey: ['odontograma', patientId],
    queryFn: ({ signal }) => odontogramApi.byPatient(patientId ?? '', signal),
    enabled: patientId !== undefined && patientId !== '',
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
        <div className="flex flex-wrap items-center gap-2">
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

      <OdontogramDocument detail={resultado.odontogram} />
    </div>
  );
};
