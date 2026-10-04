import { useQuery } from '@tanstack/react-query';
import { Alert, Spinner } from '@odontocrm/ui';
import { Activity, ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import { LinkButton } from '../components/LinkButton';
import { OdontogramHistory } from '../components/odontogram/OdontogramHistory';
import { apiErrorMessage } from '../lib/api';
import { t } from '../lib/i18n';
import { odontogramApi } from '../lib/odontogram-api';
import { useAuth } from '../providers/AuthProvider';

/**
 * `/consultorio/:patientId/odontograma/historial`: la evolución del odontograma.
 *
 * Es la vista de solo lectura del histórico: quién cambió qué, cuándo y con qué
 * notas. El permiso de escritura no hace falta aquí —el histórico no se edita—,
 * pero sí el de lectura, y la ruta lo vuelve a comprobar en el servidor.
 *
 * La página es autocontenida (sin props): el `patientId` sale de la ruta, así que
 * la puede montar cualquier router sin pasarle nada.
 */
export const OdontogramHistoryPage = () => {
  const { patientId = '' } = useParams<{ patientId: string }>();
  const { hasPermission } = useAuth();
  const puedeLeer = hasPermission('odontogram:read');

  const odontogramaQuery = useQuery({
    queryKey: ['odontograma', 'paciente', patientId],
    queryFn: ({ signal }) => odontogramApi.byPatient(patientId, signal),
    enabled: patientId !== '' && puedeLeer,
  });

  const consulta = odontogramaQuery.data;
  // `exists: false` no es un error: es un paciente al que todavía no se le ha
  // abierto el odontograma, y la vista lo dice en vez de pintar un fallo. El
  // histórico solo se pide cuando el odontograma existe de verdad: si no, el
  // servicio responde 404 (no hay fila de la que sacar nada) y no tiene sentido
  // pedirlo.
  const sinOdontograma = consulta !== undefined && !consulta.exists;

  const historialQuery = useQuery({
    queryKey: ['odontograma', 'historial', patientId],
    queryFn: ({ signal }) => odontogramApi.history(patientId, signal),
    enabled: patientId !== '' && puedeLeer && consulta?.exists === true,
  });

  const paciente =
    consulta === undefined
      ? null
      : consulta.exists
        ? consulta.odontogram.patient
        : consulta.patient;

  const cuerpo = ((): ReactNode => {
    if (patientId === '') {
      return <Alert variant="danger" title={t('odontograma.historial.pacienteRequerido')} />;
    }

    if (!puedeLeer) {
      return (
        <Alert variant="warning" title={t('odontograma.historial.sinPermiso')}>
          <p>{t('odontograma.historial.sinPermisoTexto')}</p>
        </Alert>
      );
    }

    if (odontogramaQuery.isPending || historialQuery.isPending) {
      return (
        <div className="py-12">
          <Spinner size="lg" showLabel label={t('odontograma.historial.cargando')} />
        </div>
      );
    }

    if (sinOdontograma) {
      return (
        <Alert variant="info" title={t('odontograma.historial.sinOdontograma.titulo')}>
          <p>{t('odontograma.historial.sinOdontograma.texto')}</p>
        </Alert>
      );
    }

    if (historialQuery.isError) {
      return <Alert variant="danger">{apiErrorMessage(historialQuery.error)}</Alert>;
    }

    const historial = historialQuery.data;
    if (historial === undefined) {
      return <Alert variant="danger">{t('api.error.generico')}</Alert>;
    }

    return (
      <>
        {/* La ficha del paciente es solo el encabezado: si falla, la evolución se
            muestra igual en lugar de vaciar la pantalla. */}
        {odontogramaQuery.isError && (
          <Alert variant="warning">{t('odonto.paciente.sinFicha')}</Alert>
        )}
        <OdontogramHistory entries={historial.entries} />
      </>
    );
  })();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
            <Activity className="size-5 text-primary" aria-hidden="true" />
            {t('odonto.historial.titulo')}
          </h1>
          <p className="text-sm text-ink-muted">{t('odontograma.historial.descripcion')}</p>
          {paciente !== null && (
            <p className="mt-1 text-xs text-ink-subtle">
              {paciente.fullName} · {paciente.document}
            </p>
          )}
        </div>

        {patientId !== '' && (
          <LinkButton
            to={`/consultorio?paciente=${encodeURIComponent(patientId)}`}
            variant="secondary"
            leadingIcon={<ArrowLeft className="size-4" aria-hidden="true" />}
          >
            {t('odonto.volver')}
          </LinkButton>
        )}
      </div>

      {cuerpo}
    </div>
  );
};
