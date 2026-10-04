import { formatSessionNumber, type ClinicalRecordDetail } from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  buttonClasses,
} from '@odontocrm/ui';
import { PenLine, Printer, ShieldCheck, Stethoscope } from 'lucide-react';
import { useState } from 'react';

import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import { clinicalSectionLabel, clinicalStatusLabel } from '../../lib/clinical';
import { clinicalApi } from '../../lib/endpoints';
import { formatDate } from '../../lib/format';
import { SEX_LABELS, t, type TranslationKey } from '../../lib/i18n';
import { NoticeBanner } from '../NoticeBanner';
import { OdontogramPanel } from '../odontogram/OdontogramPanel';
import { AmendmentDialog } from './AmendmentDialog';
import { ClinicalAlerts } from './ClinicalAlerts';
import { ConsentDialog } from './ConsentDialog';
import { MedicalRecordForm } from './MedicalRecordForm';
import { SessionPanel } from './SessionPanel';
import { SignRecordDialog } from './SignRecordDialog';

/**
 * El **área del paciente**: su encabezado, las pestañas de historia, sesión y
 * odontograma, y los diálogos del expediente.
 *
 * Nació dentro de `/consultorio` (Fase 6) y en la Fase 8 se separó para que la
 * página unificada `/flujo` muestre **exactamente el mismo** expediente en el
 * centro de la pantalla: la evolución del día, sus adjuntos y su récipe se
 * escriben una sola vez y se ven igual desde las dos rutas. Lo único que cambia
 * entre las dos es de dónde salen el paciente y la pestaña activa.
 */

const parseSex = (value: string): string =>
  value === 'M' || value === 'F' || value === 'O' ? SEX_LABELS[value] : value;

/** Pestañas del área del paciente: historia, sesión y odontograma (Fases 6 y 7). */
export type PatientTab = 'historia' | 'sesion' | 'odontograma';

const TABS: readonly { key: PatientTab; labelKey: TranslationKey }[] = [
  { key: 'historia', labelKey: 'odonto.pestana.historia' },
  { key: 'sesion', labelKey: 'clinica.sesion.pestana' },
  { key: 'odontograma', labelKey: 'odonto.pestana.odontograma' },
];

export interface PatientWorkspaceProps {
  patientId: string;
  /** `clinical:write`: sin permiso la historia y la sesión se leen, no se escriben. */
  puedeEscribir: boolean;
  /** `odontogram:read`: la secretaría imprime el odontograma, no lo edita. */
  puedeVerOdontograma: boolean;
  /** `odontogram:write`: solo el odontólogo y el admin marcan hallazgos. */
  puedeEditarOdontograma: boolean;
  /** Pestaña de entrada (`/consultorio?paciente=…&vista=odontograma`). */
  initialTab?: PatientTab;
  /** Pestaña gobernada desde fuera: `/flujo` la mueve con los atajos. */
  tab?: PatientTab;
  onTabChange?: (tab: PatientTab) => void;
  /** Cierra el paciente en curso (volver al selector o a la cola del día). */
  onExit: () => void;
  /** Permite volver atrás solo cuando tiene sentido (`/consultorio`). */
  exitLabel?: string;
  /**
   * Cita en curso del paciente (`/flujo` la conoce): es la que respalda la sesión
   * que se abra, para que «atendido» no tenga que pedir motivo.
   */
  appointmentId?: string | null;
  /**
   * Contador que pide cerrar la sesión clínica abierta (atajo `F8` de `/flujo`).
   * Cambiar el número abre el diálogo de cierre; `0` no pide nada.
   */
  closeSessionRequest?: number;
}

export const PatientWorkspace = ({
  patientId,
  puedeEscribir,
  puedeVerOdontograma,
  puedeEditarOdontograma,
  initialTab = 'historia',
  tab: tabControlada,
  onTabChange,
  onExit,
  exitLabel,
  appointmentId = null,
  closeSessionRequest = 0,
}: PatientWorkspaceProps) => {
  const queryClient = useQueryClient();
  const { notice, exito, error, limpiar } = useNotice();
  const [dialogo, setDialogo] = useState<'consentimiento' | 'firma' | 'adenda' | null>(null);
  const [pestanaInterna, setPestanaInterna] = useState<PatientTab>(initialTab);
  const pestana = tabControlada ?? pestanaInterna;

  const cambiarPestana = (siguiente: PatientTab): void => {
    setPestanaInterna(siguiente);
    onTabChange?.(siguiente);
  };

  const queryKey = ['clinica', 'paciente', patientId] as const;
  const sesionesKey = ['clinica', 'sesiones', patientId] as const;

  const registroQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => clinicalApi.recordByPatient(patientId, signal),
  });

  /**
   * Las sesiones del paciente se leen **una vez** y las comparten la pestaña de la
   * sesión (que retoma el borrador) y el odontograma (que marca cada hallazgo con
   * la sesión en la que se registró).
   */
  const sesionesQuery = useQuery({
    queryKey: sesionesKey,
    queryFn: ({ signal }) => clinicalApi.sessions(patientId, signal),
  });

  const sesiones = sesionesQuery.data?.items ?? [];
  const sesionAbierta = sesiones.find((session) => session.status === 'borrador') ?? null;

  const recargarSesiones = (): void => {
    void queryClient.invalidateQueries({ queryKey: sesionesKey });
  };

  const abrir = useMutation({
    mutationFn: () => clinicalApi.openRecord(patientId),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKey, { exists: true, record: detail });
      exito(t('clinica.exito.abierta'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const aplicarDetalle = (detail: ClinicalRecordDetail): void => {
    queryClient.setQueryData(queryKey, { exists: true, record: detail });
  };

  if (registroQuery.isLoading) {
    return <Spinner size="lg" showLabel label={t('comun.cargando')} />;
  }

  if (registroQuery.isError || registroQuery.data === undefined) {
    return <Alert variant="danger">{apiErrorMessage(registroQuery.error)}</Alert>;
  }

  const resultado = registroQuery.data;
  const registro = resultado.exists ? resultado.record : null;
  const paciente = resultado.exists ? resultado.record.patient : resultado.patient;

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

      {/* Encabezado del paciente: quién es, si su historia está firmada y el
          camino de vuelta al selector. */}
      <Card>
        <CardHeader className="flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Stethoscope className="mt-0.5 size-5 text-primary" aria-hidden />
            <div>
              <CardTitle>{paciente?.fullName ?? t('clinica.paciente.desconocido')}</CardTitle>
              <p className="mt-0.5 text-sm text-ink-muted">
                {paciente
                  ? `${paciente.document} · ${paciente.age} ${t('clinica.documento.anios')} · ${parseSex(paciente.sex)}`
                  : t('clinica.paciente.sinFicha')}
              </p>
              {registro !== null && (
                <p className="mt-1 text-xs text-ink-subtle">
                  {t('clinica.paciente.abierta', { fecha: formatDate(registro.openedAt) })}
                  {registro.signedAt
                    ? ` · ${t('clinica.documento.firmada', {
                        fecha: formatDate(registro.signedAt),
                        usuario: registro.signedByUsername ?? '',
                      })}`
                    : ''}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {registro !== null && (
              <Badge variant={registro.status === 'firmada' ? 'success' : 'info'}>
                {clinicalStatusLabel(registro.status)}
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={onExit}>
              {exitLabel ?? t('clinica.selector.cambiar')}
            </Button>
          </div>
        </CardHeader>
      </Card>

      {/* Primera visita: el aviso obligatorio vive en la pestaña de la historia, y
          cuando el flujo abre directamente la sesión se repite aquí para que no
          se pueda empezar a escribir sin verlo. */}
      {resultado.exists === false && pestana !== 'historia' && (
        <Alert variant="warning" title={t('clinica.primeraVisita.titulo')}>
          <p>{t('clinica.primeraVisita.texto')}</p>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => cambiarPestana('historia')}>
              {t('clinica.primeraVisita.irHistoria')}
            </Button>
          </div>
        </Alert>
      )}

      {/* Pestañas del área del paciente: la historia clínica (Fase 6A), la sesión
          del día (Fase 7A) y el odontograma (Fase 6B) comparten contexto. */}
      {puedeVerOdontograma && (
        <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={pestana === tab.key}
              onClick={() => cambiarPestana(tab.key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                pestana === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t(tab.labelKey)}
              {tab.key === 'sesion' && sesionAbierta !== null && (
                <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                  {formatSessionNumber(sesionAbierta.sessionNumber)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {pestana === 'odontograma' && puedeVerOdontograma ? (
        <OdontogramPanel
          patientId={patientId}
          canWrite={puedeEditarOdontograma}
          sessionId={sesionAbierta?.id ?? null}
        />
      ) : pestana === 'sesion' ? (
        <SessionPanel
          patientId={patientId}
          patientName={
            resultado.exists
              ? (resultado.record.patient?.fullName ?? t('clinica.paciente.desconocido'))
              : t('clinica.paciente.desconocido')
          }
          canWrite={puedeEscribir}
          openSession={sesionAbierta}
          sessions={sesiones}
          onChanged={recargarSesiones}
          appointmentId={appointmentId}
          onOpenOdontogram={puedeVerOdontograma ? () => cambiarPestana('odontograma') : undefined}
          closeRequest={closeSessionRequest}
          onCloseBlocked={() => error(t('flujo.cerrar.sinContenido'))}
        />
      ) : (
        <>
          {resultado.exists === false && (
            <Alert variant="warning" title={t('clinica.primeraVisita.titulo')}>
              <p>{t('clinica.primeraVisita.texto')}</p>
              {puedeEscribir && (
                <div className="mt-3">
                  <Button
                    loading={abrir.isPending}
                    onClick={() => abrir.mutate()}
                    leadingIcon={<PenLine className="size-4" aria-hidden />}
                  >
                    {t('clinica.primeraVisita.abrir')}
                  </Button>
                </div>
              )}
            </Alert>
          )}

          {registro !== null && (
            <div className="space-y-5">
              <ClinicalAlerts alerts={registro.alerts} />

              <div className="flex flex-wrap items-center gap-2">
                {puedeEscribir && registro.status === 'borrador' && (
                  <Button
                    variant="secondary"
                    onClick={() => setDialogo('consentimiento')}
                    leadingIcon={<ShieldCheck className="size-4" aria-hidden />}
                  >
                    {registro.consentAccepted
                      ? t('clinica.consentimiento.registrado')
                      : t('clinica.consentimiento.registrar')}
                  </Button>
                )}
                {puedeEscribir && registro.status === 'borrador' && (
                  <Button
                    onClick={() => setDialogo('firma')}
                    leadingIcon={<PenLine className="size-4" aria-hidden />}
                  >
                    {t('clinica.firma.firmar')}
                  </Button>
                )}
                {puedeEscribir && registro.status === 'firmada' && (
                  <Button
                    variant="secondary"
                    onClick={() => setDialogo('adenda')}
                    leadingIcon={<PenLine className="size-4" aria-hidden />}
                  >
                    {t('clinica.adenda.agregar')}
                  </Button>
                )}
                <a
                  className={buttonClasses({ variant: 'secondary' })}
                  href={`/consultorio/${registro.id}/imprimir`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Printer className="size-4" aria-hidden />
                  <span className="truncate">{t('clinica.imprimir.accion')}</span>
                </a>
              </div>

              {registro.consent && (
                <p className="text-sm text-ink-muted">
                  {t('clinica.consentimiento.aceptadoPor', {
                    nombre: registro.consent.acceptedByName ?? '',
                    relacion: registro.consent.relationship ?? '',
                  })}
                  {registro.consent.acceptedAt
                    ? ` · ${formatDate(registro.consent.acceptedAt)}`
                    : ''}
                </p>
              )}

              <MedicalRecordForm
                record={registro}
                canWrite={puedeEscribir}
                onSaved={aplicarDetalle}
                onError={(fallo) => error(apiErrorMessage(fallo))}
              />

              {registro.amendments.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>{t('clinica.adenda.titulo')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-3">
                      {registro.amendments.map((adenda) => (
                        <li key={adenda.id} className="rounded-control border border-border p-3">
                          <p className="text-sm font-medium text-ink">
                            {formatDate(adenda.createdAt)} ·{' '}
                            {adenda.sectionKey === null
                              ? t('clinica.adenda.general')
                              : clinicalSectionLabel(adenda.sectionKey)}
                          </p>
                          <p className="mt-1 text-sm text-ink-muted">{adenda.content}</p>
                          <p className="mt-1 text-xs text-ink-subtle">
                            {t('clinica.adenda.motivo')}: {adenda.reason}
                            {adenda.authorUsername ? ` · ${adenda.authorUsername}` : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Los diálogos de la historia solo viven en su pestaña. */}
          {registro !== null && (
            <>
              <ConsentDialog
                open={dialogo === 'consentimiento'}
                recordId={registro.id}
                patient={registro.patient}
                onClose={() => setDialogo(null)}
                onDone={() => {
                  void registroQuery.refetch();
                  exito(t('clinica.exito.consentimiento'));
                }}
              />
              <SignRecordDialog
                open={dialogo === 'firma'}
                record={registro}
                onClose={() => setDialogo(null)}
                onSigned={(detail) => {
                  aplicarDetalle(detail);
                  exito(t('clinica.exito.firmada'));
                }}
              />
              <AmendmentDialog
                open={dialogo === 'adenda'}
                recordId={registro.id}
                onClose={() => setDialogo(null)}
                onDone={() => {
                  void registroQuery.refetch();
                  exito(t('clinica.exito.adenda'));
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  );
};
