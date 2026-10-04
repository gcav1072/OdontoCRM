import {
  formatSessionNumber,
  type ClinicalRecordDetail,
  type PatientSummary,
} from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Spinner,
  buttonClasses,
} from '@odontocrm/ui';
import { ContactRound, PenLine, Printer, Search, ShieldCheck, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AmendmentDialog } from '../components/clinical/AmendmentDialog';
import { ClinicalAlerts } from '../components/clinical/ClinicalAlerts';
import { ConsentDialog } from '../components/clinical/ConsentDialog';
import { MedicalRecordForm } from '../components/clinical/MedicalRecordForm';
import { SessionPanel } from '../components/clinical/SessionPanel';
import { SignRecordDialog } from '../components/clinical/SignRecordDialog';
import { OdontogramPanel } from '../components/odontogram/OdontogramPanel';
import { NoticeBanner } from '../components/NoticeBanner';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { clinicalSectionLabel, clinicalStatusLabel } from '../lib/clinical';
import { clinicalApi, patientsApi } from '../lib/endpoints';
import { formatDate } from '../lib/format';
import { SEX_LABELS, t, type TranslationKey } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';

const parseSex = (value: string): string =>
  value === 'M' || value === 'F' || value === 'O' ? SEX_LABELS[value] : value;

/** Selector de paciente: se busca y se entra a su historia clínica. */
const PatientPicker = ({ onSelect }: { onSelect: (patientId: string) => void }) => {
  const [busqueda, setBusqueda] = useState('');
  const diferida = useDebouncedValue(busqueda, 350);

  const pacientesQuery = useQuery({
    queryKey: ['clinica', 'selector-paciente', diferida],
    queryFn: ({ signal }) =>
      patientsApi.list(
        {
          search: diferida.trim() === '' ? undefined : diferida.trim(),
          page: 1,
          pageSize: 10,
        },
        signal,
      ),
  });

  const pacientes = pacientesQuery.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('clinica.selector.titulo')}</CardTitle>
        <p className="text-sm text-ink-muted">{t('clinica.selector.texto')}</p>
      </CardHeader>
      <CardContent>
        <div className="relative max-w-lg">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden
          />
          <Input
            className="pl-9"
            value={busqueda}
            placeholder={t('clinica.selector.placeholder')}
            onChange={(event) => setBusqueda(event.target.value)}
          />
        </div>

        <div className="mt-4">
          {pacientesQuery.isLoading && <Spinner showLabel label={t('comun.cargando')} />}
          {pacientesQuery.isError && (
            <Alert variant="danger">{apiErrorMessage(pacientesQuery.error)}</Alert>
          )}
          {!pacientesQuery.isLoading && !pacientesQuery.isError && pacientes.length === 0 && (
            <EmptyState
              icon={<ContactRound className="size-5" aria-hidden />}
              title={t('clinica.selector.vacio')}
              description={t('clinica.selector.vacioTexto')}
            />
          )}
          {pacientes.length > 0 && (
            <ul className="divide-y divide-border rounded-control border border-border">
              {pacientes.map((paciente: PatientSummary) => (
                <li key={paciente.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(paciente.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-muted"
                  >
                    <span>
                      <span className="block text-sm font-medium text-ink">
                        {paciente.fullName}
                      </span>
                      <span className="block text-xs text-ink-subtle">
                        {paciente.document} · {paciente.age} {t('clinica.documento.anios')} ·{' '}
                        {parseSex(paciente.sex)}
                      </span>
                    </span>
                    <Badge variant="info">{t('clinica.selector.abrir')}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

interface RecordWorkspaceProps {
  patientId: string;
  puedeEscribir: boolean;
  /** `odontogram:read`: la secretaría imprime el odontograma, no lo edita. */
  puedeVerOdontograma: boolean;
  /** `odontogram:write`: solo el odontólogo y el admin marcan hallazgos. */
  puedeEditarOdontograma: boolean;
  /** Pestaña de entrada (`/consultorio?paciente=…&vista=odontograma`). */
  initialTab?: PatientTab;
  onExit: () => void;
}

/** Pestañas del área del paciente: historia, sesión y odontograma (Fases 6 y 7). */
type PatientTab = 'historia' | 'sesion' | 'odontograma';

const TABS: readonly { key: PatientTab; labelKey: TranslationKey }[] = [
  { key: 'historia', labelKey: 'odonto.pestana.historia' },
  { key: 'sesion', labelKey: 'clinica.sesion.pestana' },
  { key: 'odontograma', labelKey: 'odonto.pestana.odontograma' },
];

const RecordWorkspace = ({
  patientId,
  puedeEscribir,
  puedeVerOdontograma,
  puedeEditarOdontograma,
  initialTab = 'historia',
  onExit,
}: RecordWorkspaceProps) => {
  const queryClient = useQueryClient();
  const { notice, exito, error, limpiar } = useNotice();
  const [dialogo, setDialogo] = useState<'consentimiento' | 'firma' | 'adenda' | null>(null);
  const [pestana, setPestana] = useState<PatientTab>(initialTab);

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
              {t('clinica.selector.cambiar')}
            </Button>
          </div>
        </CardHeader>
      </Card>

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
              onClick={() => setPestana(tab.key)}
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
          canWrite={puedeEscribir}
          openSession={sesionAbierta}
          sessions={sesiones}
          onChanged={recargarSesiones}
          onOpenOdontogram={puedeVerOdontograma ? () => setPestana('odontograma') : undefined}
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

/**
 * `/consultorio`: la historia clínica, la sesión del día y el odontograma.
 *
 * Muestra el aviso obligatorio cuando el paciente no tiene historia («primera
 * visita»), el formulario por pasos con guardado de borrador y, ya firmada, el
 * bloqueo con adendas; la pestaña de **sesión** (Fase 7A) escribe la evolución de
 * la visita y el odontograma se marca dentro de ella. La escritura exige
 * `clinical:write`; leer e imprimir basta con `clinical:read` (la secretaría
 * imprime la historia y el odontograma).
 */
export const ConsultorioPage = () => {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const patientId = params.get('paciente');
  // La ficha del paciente enlaza directo a la pestaña del odontograma y la
  // secretaría, a la sesión.
  const vista = params.get('vista');
  const vistaInicial: PatientTab =
    vista === 'odontograma' ? 'odontograma' : vista === 'sesion' ? 'sesion' : 'historia';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">{t('modulo.consultorio.titulo')}</h1>
        <p className="text-sm text-ink-muted">{t('modulo.consultorio.descripcion')}</p>
      </div>

      {patientId === null ? (
        <PatientPicker onSelect={(id) => setParams({ paciente: id })} />
      ) : (
        <RecordWorkspace
          patientId={patientId}
          puedeEscribir={hasPermission('clinical:write')}
          puedeVerOdontograma={hasPermission('odontogram:read')}
          puedeEditarOdontograma={hasPermission('odontogram:write')}
          initialTab={vistaInicial}
          onExit={() => setParams({})}
        />
      )}
    </div>
  );
};
