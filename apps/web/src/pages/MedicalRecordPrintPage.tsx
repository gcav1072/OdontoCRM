import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Spinner } from '@odontocrm/ui';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { MedicalRecordDocument } from '../components/clinical/MedicalRecordDocument';
import { MargenDeImpresion } from '../components/print/MargenDeImpresion';
import { apiErrorMessage } from '../lib/api';
import { clinicalApi } from '../lib/endpoints';
import { useMargenDeImpresion, useTemaClaroParaImprimir } from '../lib/impresion';
import { t } from '../lib/i18n';

/**
 * Vista de impresión de la historia clínica: se abre en una pestaña propia
 * (fuera del shell, para que el papel no lleve navegación) y la comparte la
 * secretaría, que **imprime pero no escribe**.
 *
 * Cada impresión deja constancia en la auditoría con su actor; si esa llamada
 * falla, la impresión sale igual: primero está el papel.
 */
export const MedicalRecordPrintPage = () => {
  // El informe se imprime con la paleta clara aunque la pantalla esté en modo
  // oscuro: el papel es blanco (ver lib/impresion.ts).
  useTemaClaroParaImprimir();
  // Tamaño carta con margen elegido en la barra (por defecto, 15 mm).
  const [margen, setMargen] = useMargenDeImpresion();
  const { id } = useParams<{ id: string }>();
  const [aviso, setAviso] = useState<string | null>(null);

  const registroQuery = useQuery({
    queryKey: ['clinica', 'registro', id],
    queryFn: ({ signal }) => clinicalApi.getRecord(id ?? '', signal),
    enabled: id !== undefined,
  });

  const registrarImpresion = useMutation({
    mutationFn: () => clinicalApi.registerPrint(id ?? ''),
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

  if (id === undefined) {
    return <Alert variant="danger">{t('clinica.error.sinRegistro')}</Alert>;
  }

  if (registroQuery.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner size="lg" showLabel label={t('comun.cargando')} />
      </div>
    );
  }

  if (registroQuery.isError || registroQuery.data === undefined) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Alert variant="danger" title={t('clinica.error.titulo')}>
          {apiErrorMessage(registroQuery.error)}
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas pb-10 print:pb-0">
      <div className="mx-auto flex max-w-[21cm] flex-wrap items-center justify-between gap-3 px-6 py-4 print:hidden">
        <div className="flex items-center gap-2 text-ink-muted">
          <FileText className="size-4" aria-hidden />
          <span className="text-sm">{t('clinica.imprimir.titulo')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Cuánto blanco deja el borde de la hoja (carta) antes del documento. */}
          <MargenDeImpresion margenMm={margen} onChange={setMargen} />
          <Button variant="secondary" onClick={() => window.close()}>
            {t('comun.cerrar')}
          </Button>
          <Button loading={registrarImpresion.isPending} onClick={() => void imprimir()}>
            {t('clinica.imprimir.accion')}
          </Button>
        </div>
      </div>

      {aviso !== null && (
        <div className="mx-auto max-w-[21cm] px-6 print:hidden">
          <Alert variant="warning">{aviso}</Alert>
        </div>
      )}

      <MedicalRecordDocument record={registroQuery.data} />
    </div>
  );
};
