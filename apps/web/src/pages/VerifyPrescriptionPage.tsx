import { CLINIC } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardContent, CardHeader, CardTitle, Spinner } from '@odontocrm/ui';
import { BadgeCheck, ShieldQuestion } from 'lucide-react';
import { useParams } from 'react-router-dom';

import { apiErrorMessage } from '../lib/api';
import { clinicalApi } from '../lib/endpoints';
import { formatDate } from '../lib/format';
import { t } from '../lib/i18n';

/**
 * `/verificar/<código>`: la página **pública** que abre el QR del récipe.
 *
 * Confirma que el papel es auténtico y **nada más** (ADR 0015): el nombre del
 * consultorio, la fecha, quién lo firmó y el nombre abreviado del paciente, que es
 * lo que deja ver que ese récipe es suyo. Ni diagnóstico, ni medicamentos, ni
 * cédula: quien escanee un papel encontrado no aprende nada clínico de nadie.
 *
 * No usa la sesión del personal —la abre el paciente o la farmacia— así que vive
 * fuera del shell y su llamada va sin token.
 */
export const VerifyPrescriptionPage = () => {
  const { code = '' } = useParams<{ code: string }>();

  const consulta = useQuery({
    queryKey: ['verificacion-recipe', code],
    queryFn: ({ signal }) => clinicalApi.verifyPrescription(code, signal),
    retry: false,
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4 py-10">
      <header className="text-center">
        <p className="text-lg font-semibold text-ink">{CLINIC.name}</p>
        <p className="text-sm text-ink-muted">{t('verificar.subtitulo')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('verificar.titulo')}</CardTitle>
          <p className="text-sm text-ink-muted">{t('verificar.texto')}</p>
        </CardHeader>

        <CardContent className="space-y-4">
          {consulta.isLoading && <Spinner showLabel label={t('verificar.comprobando')} />}

          {consulta.isError && (
            <p className="rounded-control border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
              {apiErrorMessage(consulta.error)}
            </p>
          )}

          {consulta.data?.valid === true && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-base font-medium text-success">
                <BadgeCheck className="size-5" aria-hidden />
                {t('verificar.valido')}
              </p>

              <dl className="grid gap-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{t('verificar.codigo')}</dt>
                  <dd className="font-mono text-ink">{consulta.data.code}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{t('verificar.paciente')}</dt>
                  <dd className="text-ink">{consulta.data.patientReference}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{t('verificar.fecha')}</dt>
                  <dd className="text-ink">{formatDate(consulta.data.issuedAt)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{t('verificar.odontologo')}</dt>
                  <dd className="text-right text-ink">
                    {consulta.data.dentistName ?? t('verificar.sinDato')}
                    {consulta.data.dentistMpps === null ? '' : ` · ${consulta.data.dentistMpps}`}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{t('verificar.medicamentos')}</dt>
                  <dd className="text-ink">{consulta.data.itemCount}</dd>
                </div>
              </dl>

              <p>
                <Badge variant={consulta.data.status === 'anulada' ? 'danger' : 'success'}>
                  {consulta.data.status === 'anulada'
                    ? t('verificar.anulado')
                    : t('verificar.vigente')}
                </Badge>
              </p>

              {consulta.data.status === 'anulada' && (
                <p className="text-sm text-danger">{t('verificar.anuladoTexto')}</p>
              )}
            </div>
          )}

          {consulta.data?.valid === false && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-base font-medium text-danger">
                <ShieldQuestion className="size-5" aria-hidden />
                {t('verificar.noConsta')}
              </p>
              <p className="text-sm text-ink-muted">
                {t('verificar.noConstaTexto', { codigo: consulta.data.code })}
              </p>
            </div>
          )}

          <p className="text-xs text-ink-subtle">{t('verificar.privacidad')}</p>
        </CardContent>
      </Card>

      <footer className="text-center text-xs text-ink-subtle">
        {[CLINIC.rif === null ? null : `RIF ${CLINIC.rif}`, CLINIC.phones[0] ?? null]
          .filter((linea): linea is string => linea !== null)
          .join(' · ')}
      </footer>
    </main>
  );
};
