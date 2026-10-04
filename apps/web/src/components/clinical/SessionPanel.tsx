import {
  clinicalSessionHasContent,
  sessionProcedureText,
  type AppointmentSummary,
  type ClinicalSessionDetail,
  type ClinicalSessionSummary,
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
  Field,
  Select,
  Spinner,
} from '@odontocrm/ui';
import {
  CalendarCheck,
  ClipboardList,
  PlayCircle,
  ShieldCheck,
  Smile,
  Stethoscope,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import {
  emptySessionDraft,
  sessionNumberLabel,
  sessionSaveLabel,
  type SessionSaveState,
} from '../../lib/clinical-session';
import { clinicalApi, appointmentsApi } from '../../lib/endpoints';
import { formatDate, formatTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { NoticeBanner } from '../NoticeBanner';
import { AmendSessionDialog } from './AmendSessionDialog';
import { CloseSessionDialog } from './CloseSessionDialog';
import { PrescriptionCard } from './PrescriptionCard';
import { PrescriptionDialog } from './PrescriptionDialog';
import { SessionAttachments } from './SessionAttachments';
import { SessionForm } from './SessionForm';

/**
 * Pestaña **Sesión** del consultorio: la evolución del paciente (Fase 7, sesión A).
 *
 * Es el formulario del día: signos vitales, examen, procedimientos con pieza y
 * caras, materiales, diagnóstico, indicaciones y próxima cita, con **autoguardado**
 * (lo que se escribe no se pierde si se cierra la pestaña) y cierre inmutable.
 * El odontograma se marca en su pestaña y queda ligado a esta sesión.
 */

/** Cuánto se espera desde la última tecla antes de guardar. */
const AUTOSAVE_MS = 1200;

export interface SessionPanelProps {
  patientId: string;
  /** Nombre del paciente, para el encabezado del récipe. */
  patientName: string;
  /** `clinical:write`: sin permiso la sesión se lee, no se escribe. */
  canWrite: boolean;
  /** Sesión en borrador del paciente, si la hay (la comparte la pestaña hermana). */
  openSession: ClinicalSessionSummary | null;
  /** Sesiones del paciente, de la última a la primera. */
  sessions: readonly ClinicalSessionSummary[];
  /** Recarga la lista de sesiones (abrir, cerrar, enmendar). */
  onChanged: () => void;
  /** Lleva a la pestaña del odontograma: lo que se marca allí cae en esta sesión. */
  onOpenOdontogram?: (() => void) | undefined;
  /**
   * Contador que pide cerrar la sesión abierta: el atajo `F8` de `/flujo` lo
   * incrementa. Cada cambio de número abre el diálogo de cierre (y si la sesión
   * todavía no tiene contenido, avisa con `onCloseBlocked`).
   */
  closeRequest?: number;
  /** La sesión no se puede cerrar todavía: el contenedor lo dice en pantalla. */
  onCloseBlocked?: () => void;
}

/** Fecha de hoy en la zona del consultorio (la que usa la agenda). */
const today = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });

/** Fila de una sesión cerrada: número, fecha, resumen y acciones. */
const ClosedSessionCard = ({
  session,
  canWrite,
  onAmend,
}: {
  session: ClinicalSessionSummary;
  canWrite: boolean;
  onAmend: (session: ClinicalSessionSummary) => void;
}) => (
  <li className="rounded-control border border-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">
          {sessionNumberLabel(session.sessionNumber)} ·{' '}
          {formatDate(session.closedAt ?? session.openedAt)}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">{session.summary}</p>
        {session.amendmentReason !== null && (
          <p className="mt-0.5 text-xs text-ink-subtle">
            {t('clinica.sesion.enmendada', { motivo: session.amendmentReason })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">{t('clinica.sesion.estado.cerrada')}</Badge>
        {canWrite && (
          <Button variant="ghost" size="sm" onClick={() => onAmend(session)}>
            {t('clinica.sesion.corregir')}
          </Button>
        )}
      </div>
    </div>
  </li>
);

export const SessionPanel = ({
  patientId,
  patientName,
  canWrite,
  openSession,
  sessions,
  onChanged,
  onOpenOdontogram,
  closeRequest = 0,
  onCloseBlocked,
}: SessionPanelProps) => {
  const queryClient = useQueryClient();
  const { notice, exito, error, limpiar } = useNotice();

  const [contenido, setContenido] = useState(() => emptySessionDraft());
  const [citaElegida, setCitaElegida] = useState<string>('');
  const [guardado, setGuardado] = useState<SessionSaveState>('limpio');
  const [horaGuardado, setHoraGuardado] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<'cerrar' | 'corregir' | 'recipe' | null>(null);
  const [aCorregir, setACorregir] = useState<ClinicalSessionSummary | null>(null);
  /** ¿Hay que abrir el récipe al terminar de cerrar la sesión? */
  const [recipeAlCerrar, setRecipeAlCerrar] = useState(false);

  /** Última versión enviada al servidor: evita guardar lo que no cambió. */
  const ultimoEnviado = useRef<string>('');

  const sessionId = openSession?.id ?? null;
  const sesionQuery = useQuery({
    queryKey: ['clinica', 'sesion', sessionId],
    queryFn: ({ signal }) => clinicalApi.getSession(sessionId ?? '', signal),
    enabled: sessionId !== null,
  });

  /**
   * Adjuntos y récipes de la sesión que se está viendo. Si no hay sesión abierta se
   * enseña la **última cerrada** (en solo lectura): así lo que se subió o se recetó
   * en la visita no desaparece de la pantalla al cerrarla.
   */
  const sesionVisible = openSession ?? sessions.find((item) => item.status === 'cerrada') ?? null;
  const sesionVisibleId = sesionVisible?.id ?? null;
  const sesionCerrada = sesionVisible !== null && sesionVisible.status === 'cerrada';

  const recetasClave = ['clinica', 'recetas-sesion', sesionVisibleId] as const;
  const recetasPacienteClave = ['clinica', 'recetas-paciente', patientId] as const;

  const recetasQuery = useQuery({
    queryKey: recetasClave,
    queryFn: ({ signal }) => clinicalApi.prescriptionsBySession(sesionVisibleId ?? '', signal),
    enabled: sesionVisibleId !== null,
  });

  const recetasPacienteQuery = useQuery({
    queryKey: recetasPacienteClave,
    queryFn: ({ signal }) => clinicalApi.prescriptionsByPatient(patientId, signal),
    enabled: sesionVisibleId === null,
  });

  // Al abrir (o cambiar de) sesión, el formulario parte del documento guardado.
  useEffect(() => {
    if (sesionQuery.data === undefined) return;
    setContenido(sesionQuery.data.content);
    ultimoEnviado.current = JSON.stringify(sesionQuery.data.content);
    setGuardado('limpio');
    setHoraGuardado(null);
  }, [sesionQuery.data]);

  /** Citas de hoy del paciente: es lo que enlaza la sesión con el «atendido». */
  const citasQuery = useQuery({
    queryKey: ['clinica', 'citas-hoy', patientId],
    queryFn: ({ signal }) =>
      appointmentsApi.list({ date: today(), patientId, page: 1, pageSize: 20 }, signal),
    enabled: canWrite && openSession === null,
  });

  const citas = useMemo<readonly AppointmentSummary[]>(
    () => citasQuery.data?.items ?? [],
    [citasQuery.data],
  );

  const enConsulta = citas.find((cita) => cita.status === 'en_consulta');
  useEffect(() => {
    if (enConsulta !== undefined && citaElegida === '') setCitaElegida(enConsulta.id);
  }, [enConsulta, citaElegida]);

  const abrir = useMutation({
    mutationFn: () =>
      clinicalApi.openSession(patientId, {
        appointmentId: citaElegida === '' ? null : citaElegida,
        motivo: null,
      }),
    onSuccess: () => {
      onChanged();
      exito(t('clinica.sesion.exito.abierta'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const guardar = useMutation({
    mutationFn: (content: Parameters<typeof clinicalApi.saveSession>[1]) =>
      clinicalApi.saveSession(sessionId ?? '', content),
    onSuccess: (detail) => {
      ultimoEnviado.current = JSON.stringify(detail.content);
      setGuardado('guardado');
      setHoraGuardado(
        new Date().toLocaleTimeString('es-VE', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }),
      );
      onChanged();
    },
    onError: (fallo) => {
      setGuardado('error');
      error(apiErrorMessage(fallo));
    },
  });

  /**
   * Autoguardado: se dispara al dejar de teclear. Se compara con lo último enviado
   * para no escribir de más (el servidor, además, no escribe si no cambió nada).
   */
  useEffect(() => {
    if (sessionId === null || !canWrite) return;
    if (JSON.stringify(contenido) === ultimoEnviado.current) return;

    setGuardado('pendiente');
    const timer = setTimeout(() => {
      setGuardado('guardando');
      guardar.mutate(contenido);
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // `guardar` es estable entre dibujados; solo interesa el contenido y la sesión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contenido, sessionId, canWrite]);

  /**
   * El atajo `F8` de `/flujo` pide cerrar la sesión del paciente en curso: abre el
   * mismo diálogo que el botón (con la pregunta del récipe) y, si la sesión todavía no
   * tiene contenido, avisa en vez de abrir un cierre que el servidor rechazaría.
   *
   * El número se recuerda para que el pedido se atienda **una vez**: cada tecla
   * posterior no vuelve a abrir el diálogo.
   */
  const ultimoPedido = useRef(0);
  useEffect(() => {
    if (closeRequest <= 0 || closeRequest === ultimoPedido.current) return;
    ultimoPedido.current = closeRequest;

    if (openSession === null || !canWrite) return;
    if (!clinicalSessionHasContent(contenido)) {
      onCloseBlocked?.();
      return;
    }
    setDialogo('cerrar');
  }, [closeRequest, openSession, canWrite, contenido, onCloseBlocked]);

  /**
   * Cerrar la sesión. Si el doctor dijo que sí al récipe, al terminar se abre el
   * editor: la sesión ya está cerrada (el récipe cuelga de ella y no la reabre).
   *
   * Antes de cerrar se guarda lo que quede pendiente: el cierre es inmutable y el
   * autoguardado espera 1,2 s desde la última tecla, así que cerrar sin guardar
   * —con el botón o con `F8`— perdería lo último escrito.
   */
  const cerrar = useMutation({
    mutationFn: async (values: { closureNote: string | null }) => {
      if (sessionId !== null && JSON.stringify(contenido) !== ultimoEnviado.current) {
        const guardada = await clinicalApi.saveSession(sessionId, contenido);
        ultimoEnviado.current = JSON.stringify(guardada.content);
        setGuardado('guardado');
      }
      return clinicalApi.closeSession(sessionId ?? '', {
        confirm: true,
        closureNote: values.closureNote,
      });
    },
    onSuccess: () => {
      setDialogo(recipeAlCerrar ? 'recipe' : null);
      setRecipeAlCerrar(false);
      onChanged();
      exito(t('clinica.sesion.exito.cerrada'));
    },
    onError: (fallo) => {
      setRecipeAlCerrar(false);
      error(apiErrorMessage(fallo));
    },
  });

  const enmendar = useMutation({
    mutationFn: (values: { reason: string }) =>
      clinicalApi.amendSession(aCorregir?.id ?? '', { reason: values.reason }),
    onSuccess: () => {
      setDialogo(null);
      setACorregir(null);
      onChanged();
      exito(t('clinica.sesion.exito.enmendada'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  /** Marca la cita como atendida con la sesión cerrada como respaldo. */
  const marcarAtendida = useMutation({
    mutationFn: (input: { appointmentId: string; sessionId: string }) =>
      appointmentsApi.attend(input.appointmentId, { clinicalSessionId: input.sessionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clinica', 'citas-hoy', patientId] });
      exito(t('clinica.sesion.exito.atendida'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const cerradas = sessions.filter((session) => session.status === 'cerrada');
  const puedeCerrar = clinicalSessionHasContent(contenido);

  /**
   * La cita que se puede cerrar como atendida: la que está en el consultorio y ya
   * tiene su sesión cerrada. Se ofrece aquí —y no se hace sola— porque marcar
   * «atendido» es un acto de secretaría que el doctor confirma.
   */
  const citaParaAtender = citas
    .filter((cita) => cita.status === 'en_consulta')
    .map((cita) => ({
      cita,
      session: cerradas.find((session) => session.appointmentId === cita.id),
    }))
    .find((par) => par.session !== undefined);

  /** Adjuntos y récipes de la visita que se está viendo (o del historial). */
  const adjuntosRecetas = (
    <>
      {sesionVisibleId !== null && (
        <SessionAttachments
          sessionId={sesionVisibleId}
          canWrite={canWrite && !sesionCerrada}
          sessionClosed={sesionCerrada}
        />
      )}

      {sesionVisibleId !== null ? (
        <PrescriptionCard
          prescriptions={recetasQuery.data?.items ?? []}
          loading={recetasQuery.isLoading}
          canWrite={canWrite && !sesionCerrada}
          onNew={canWrite && !sesionCerrada ? () => setDialogo('recipe') : undefined}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: recetasClave });
            onChanged();
          }}
        />
      ) : (
        <PrescriptionCard
          prescriptions={recetasPacienteQuery.data?.items ?? []}
          loading={recetasPacienteQuery.isLoading}
          canWrite={false}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: recetasPacienteClave });
          }}
        />
      )}
    </>
  );

  /* ── Sin sesión abierta: abrir o revisar lo hecho ────────────────────────── */

  if (openSession === null) {
    return (
      <div className="space-y-5">
        <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

        {canWrite && (
          <Card>
            <CardHeader>
              <CardTitle>{t('clinica.sesion.abrir.titulo')}</CardTitle>
              <p className="text-sm text-ink-muted">{t('clinica.sesion.abrir.texto')}</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label={t('clinica.sesion.abrir.cita')}
                hint={t('clinica.sesion.abrir.citaAyuda')}
              >
                <Select
                  className="max-w-md"
                  value={citaElegida}
                  onChange={(event) => setCitaElegida(event.target.value)}
                >
                  <option value="">{t('clinica.sesion.abrir.sinCita')}</option>
                  {citas.map((cita) => (
                    <option key={cita.id} value={cita.id}>
                      {t('clinica.sesion.abrir.citaOpcion', {
                        hora: formatTime(cita.startTime),
                        estado: cita.status,
                      })}
                    </option>
                  ))}
                </Select>
              </Field>

              <Button
                loading={abrir.isPending}
                loadingLabel={t('comun.guardando')}
                leadingIcon={<PlayCircle className="size-4" aria-hidden />}
                onClick={() => abrir.mutate()}
              >
                {t('clinica.sesion.abrir.accion')}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* El paciente está en el consultorio y su sesión ya está cerrada: aquí se
            ofrece pasar la cita a «atendida», con la sesión como respaldo. */}
        {citaParaAtender !== undefined && citaParaAtender.session !== undefined && (
          <Alert variant="success" title={t('clinica.sesion.atender.titulo')}>
            <p>
              {t('clinica.sesion.atender.texto', {
                hora: formatTime(citaParaAtender.cita.startTime),
              })}
            </p>
            <div className="mt-3">
              <Button
                variant="secondary"
                loading={marcarAtendida.isPending}
                leadingIcon={<CalendarCheck className="size-4" aria-hidden />}
                onClick={() =>
                  marcarAtendida.mutate({
                    appointmentId: citaParaAtender.cita.id,
                    sessionId: citaParaAtender.session?.id ?? '',
                  })
                }
              >
                {t('clinica.sesion.marcarAtendida')}
              </Button>
            </div>
          </Alert>
        )}

        {cerradas.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="size-5" aria-hidden />}
            title={t('clinica.sesion.sinSesiones')}
            description={t('clinica.sesion.sinSesionesTexto')}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t('clinica.sesion.historial')}</CardTitle>
              <p className="text-sm text-ink-muted">{t('clinica.sesion.historialTexto')}</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {cerradas.map((session) => (
                  <ClosedSessionCard
                    key={session.id}
                    session={session}
                    canWrite={canWrite}
                    onAmend={(elegida) => {
                      setACorregir(elegida);
                      setDialogo('corregir');
                    }}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {adjuntosRecetas}

        <AmendSessionDialog
          open={dialogo === 'corregir'}
          session={aCorregir}
          loading={enmendar.isPending}
          onClose={() => setDialogo(null)}
          onConfirm={(values) => enmendar.mutate(values)}
        />

        {sesionVisibleId !== null && (
          <PrescriptionDialog
            open={dialogo === 'recipe'}
            sessionId={sesionVisibleId}
            patientName={patientName}
            prescriptions={recetasQuery.data?.items ?? []}
            canWrite={canWrite}
            onClose={() => setDialogo(null)}
            onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: recetasClave });
              onChanged();
            }}
          />
        )}
      </div>
    );
  }

  /* ── Sesión abierta: el formulario del día ──────────────────────────────── */

  const detalle: ClinicalSessionDetail | undefined = sesionQuery.data;

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

      <Card>
        <CardHeader className="flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Stethoscope className="size-5 text-primary" aria-hidden />
              {t('clinica.sesion.titulo', {
                numero: sessionNumberLabel(openSession.sessionNumber),
              })}
            </CardTitle>
            <p className="mt-0.5 text-sm text-ink-muted">
              {t('clinica.sesion.abierta', { fecha: formatDate(openSession.openedAt) })}
              {openSession.appointmentId !== null
                ? ` · ${t('clinica.sesion.conCita')}`
                : ` · ${t('clinica.sesion.sinCita')}`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={guardado === 'error' ? 'danger' : 'info'}>
              {sessionSaveLabel(guardado, horaGuardado)}
            </Badge>
            {onOpenOdontogram !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<Smile className="size-4" aria-hidden />}
                onClick={onOpenOdontogram}
              >
                {t('clinica.sesion.irOdontograma')}
              </Button>
            )}
            {canWrite && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={guardar.isPending}
                  onClick={() => guardar.mutate(contenido)}
                >
                  {t('comun.guardar')}
                </Button>
                <Button
                  size="sm"
                  disabled={!puedeCerrar}
                  leadingIcon={<ShieldCheck className="size-4" aria-hidden />}
                  onClick={() => setDialogo('cerrar')}
                >
                  {t('clinica.sesion.cerrar.accion')}
                </Button>
              </>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {sesionQuery.isLoading && <Spinner showLabel label={t('comun.cargando')} />}
          {sesionQuery.isError && (
            <Alert variant="danger">{apiErrorMessage(sesionQuery.error)}</Alert>
          )}

          {!puedeCerrar && (
            <Alert variant="info">{t('clinica.sesion.cerrar.faltaContenido')}</Alert>
          )}

          <SessionForm
            content={contenido}
            disabled={!canWrite}
            onChange={(siguiente) => {
              setContenido(siguiente);
              setGuardado('pendiente');
            }}
          />

          {detalle !== undefined && detalle.procedureCount > 0 && (
            <p className="text-xs text-ink-subtle">
              {t('clinica.sesion.resumen')}:{' '}
              {detalle.content.procedimientos.map(sessionProcedureText).join(' · ')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Adjuntos de la visita y récipes: van debajo del documento, que es lo que
          se escribe primero. */}
      {adjuntosRecetas}

      {/* La evolución anterior sigue a la vista: se cierra una sesión y se empieza
          otra sin perder el hilo de lo que se le hizo al paciente. */}
      {cerradas.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('clinica.sesion.historial')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {cerradas.map((session) => (
                <ClosedSessionCard
                  key={session.id}
                  session={session}
                  canWrite={canWrite}
                  onAmend={(elegida) => {
                    setACorregir(elegida);
                    setDialogo('corregir');
                  }}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <CloseSessionDialog
        open={dialogo === 'cerrar'}
        loading={cerrar.isPending}
        canPrescribe={canWrite}
        onClose={() => {
          setRecipeAlCerrar(false);
          setDialogo(null);
        }}
        onConfirm={(values) => {
          setRecipeAlCerrar(values.conRecipe);
          cerrar.mutate({ closureNote: values.closureNote });
        }}
      />

      <AmendSessionDialog
        open={dialogo === 'corregir'}
        session={aCorregir}
        loading={enmendar.isPending}
        onClose={() => setDialogo(null)}
        onConfirm={(values) => enmendar.mutate(values)}
      />

      {sesionVisibleId !== null && (
        <PrescriptionDialog
          open={dialogo === 'recipe'}
          sessionId={sesionVisibleId}
          patientName={patientName}
          prescriptions={recetasQuery.data?.items ?? []}
          canWrite={canWrite}
          onClose={() => setDialogo(null)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: recetasClave });
            onChanged();
          }}
        />
      )}
    </div>
  );
};
