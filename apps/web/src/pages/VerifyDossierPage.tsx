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
 * `/verificar-expediente/<código>`: la página **pública** que abre el QR del dossier.
 *
 * Es la hermana de `/verificar/<código>` (el récipe) y responde a la misma pregunta —¿el
 * papel es auténtico?— con la misma prudencia (ADR 0015): el nombre del consultorio, la
 * fecha de emisión, quién lo firmó, el nombre **abreviado** del paciente y la huella del
 * archivo. Ni diagnósticos, ni tratamientos, ni medicamentos: un expediente es el
 * historial entero de una persona, así que lo que confirma la página es que el documento
 * consta, no lo que dice.
 *
 * Vive fuera del shell y su llamada va sin token: la abre el paciente, un especialista o
 * quien tenga el papel en la mano.
 */
export const VerifyDossierPage = () => {
  const { code = '' } = useParams<{ code: string }>();

  const consulta = useQuery({
    queryKey: ['verificacion-expediente', code],
    queryFn: ({ signal }) => clinicalApi.verifyDossier(code, signal),
    retry: false,
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4 py-10">
      <header className="text-center">
        <p className="text-lg font-semibold text-ink">{CLINIC.name}</p>
        <p className="text-sm text-ink-muted">{t('verificarExpediente.subtitulo')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('verificarExpediente.titulo')}</CardTitle>
          <p className="text-sm text-ink-muted">{t('verificarExpediente.texto')}</p>
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
                {t('verificarExpediente.valido')}
              </p>

              <dl className="grid gap-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{t('verificarExpediente.numero')}</dt>
                  <dd className="font-mono text-ink">{consulta.data.number}</dd>
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
                  <dd className="text-ink">
                    {consulta.data.dentistName ?? t('verificar.sinDato')}
                    {consulta.data.dentistMpps === null ? '' : ` · ${consulta.data.dentistMpps}`}
                  </dd>
                </div>
              </dl>

              {consulta.data.sha256 !== null && (
                <p className="break-all font-mono text-[11px] text-ink-subtle">
                  SHA-256: {consulta.data.sha256}
                </p>
              )}
            </div>
          )}

          {consulta.data?.valid === false && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-base font-medium text-danger">
                <ShieldQuestion className="size-5" aria-hidden />
                {t('verificarExpediente.noConsta')}
              </p>
              <p className="text-sm text-ink-muted">{t('verificarExpediente.noConstaTexto')}</p>
              {consulta.data.number !== null && (
                <Badge variant="info">{consulta.data.number}</Badge>
              )}
            </div>
          )}

          <p className="border-t border-border pt-3 text-xs text-ink-subtle">
            {t('verificar.privacidad')}
          </p>
        </CardContent>
      </Card>
    </main>
  );
};
