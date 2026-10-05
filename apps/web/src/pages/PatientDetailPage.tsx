import type { PatientDetail } from '@odontocrm/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
} from '@odontocrm/ui';
import {
  ArrowLeft,
  Eye,
  IdCard,
  ShieldAlert,
  Smile,
  Stethoscope,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage, isApiError } from '../lib/api';
import { patientsApi } from '../lib/endpoints';
import { formatDate, formatDateTime } from '../lib/format';
import { PATIENT_STATUS_LABELS, SEX_LABELS, t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';
import { LinkButton } from '../components/LinkButton';
import { NoticeBanner } from '../components/NoticeBanner';
import { PatientAttachments } from '../components/patients/PatientAttachments';
import { PatientAttachmentsCard } from '../components/clinical/SessionAttachments';
import { PatientSessionsCard } from '../components/clinical/PatientSessionsCard';
import { PatientDeleteDialog } from '../components/patients/PatientDeleteDialog';
import { PatientForm } from '../components/patients/PatientForm';
import { PatientStatusDialog } from '../components/patients/PatientStatusDialog';

const varianteDeEstado = (status: PatientDetail['status']) => {
  if (status === 'activo') return 'success' as const;
  if (status === 'inactivo') return 'neutral' as const;
  return 'info' as const;
};

/** Dato de la ficha: etiqueta y valor, con guion cuando no hay dato. */
const Dato = ({ etiqueta, valor }: { etiqueta: string; valor: string }) => (
  <div>
    <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{etiqueta}</dt>
    <dd className="text-sm text-ink">{valor}</dd>
  </div>
);

/**
 * Ficha del paciente: datos completos, representante, adjuntos, edición con
 * motivo y cambio de estado. El botón Editar vive dentro de `PatientForm`, que
 * es el que exige el motivo y confirma los cambios antes del `PATCH`.
 */
export const PatientDetailPage = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const cliente = useQueryClient();
  const navegar = useNavigate();
  const { notice, limpiar, exito } = useNotice();
  const [cambiandoEstado, setCambiandoEstado] = useState(false);
  const [borrando, setBorrando] = useState(false);

  const pacienteQuery = useQuery({
    queryKey: ['paciente', id],
    queryFn: ({ signal }) => patientsApi.get(id, signal),
    enabled: id !== '',
  });

  const paciente = pacienteQuery.data ?? null;

  const refrescarLista = () => {
    void cliente.invalidateQueries({ queryKey: ['pacientes'] });
  };

  if (pacienteQuery.isPending) {
    return (
      <div className="py-16">
        <Spinner label={t('pacientes.ficha.cargando')} showLabel />
      </div>
    );
  }

  if (pacienteQuery.isError) {
    const noEncontrado = isApiError(pacienteQuery.error) && pacienteQuery.error.status === 404;
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">
            {noEncontrado ? t('pacientes.ficha.noEncontrado') : t('pacientes.ficha.error')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="danger">{apiErrorMessage(pacienteQuery.error)}</Alert>
          <LinkButton
            to="/pacientes"
            variant="secondary"
            leadingIcon={<ArrowLeft className="size-4" />}
          >
            {t('pacientes.ficha.volverLista')}
          </LinkButton>
        </CardContent>
      </Card>
    );
  }

  if (paciente === null) return null;

  const edad = paciente.age;

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/pacientes"
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('pacientes.ficha.volverLista')}
        </Link>
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
              <UserRound className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <CardTitle as="h1" className="truncate text-lg">
                {paciente.fullName}
              </CardTitle>
              <p className="flex flex-wrap items-center gap-2 pt-1 font-mono text-sm text-ink-muted">
                <IdCard className="size-3.5" aria-hidden="true" />
                {paciente.document}
              </p>
              <p className="pt-1 flex flex-wrap items-center gap-1.5">
                <Badge variant={varianteDeEstado(paciente.status)} dot>
                  {PATIENT_STATUS_LABELS[paciente.status]}
                </Badge>
                <Badge variant="neutral">{t('pacientes.form.edad', { edad })}</Badge>
                <Badge variant="neutral">
                  {t('pacientes.ficha.adjuntos', { total: paciente.fileCount })}
                </Badge>
                {paciente.isMinor && <Badge variant="info">{t('pacientes.menor')}</Badge>}
                {paciente.isFictitious && (
                  <Badge variant="warning">{t('pacientes.ficticio')}</Badge>
                )}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* La historia clínica se abre desde la ficha: es el camino natural
                del odontólogo, y la secretaría entra en solo lectura. */}
            {hasPermission('clinical:read') && (
              <LinkButton
                to={`/consultorio?paciente=${paciente.id}`}
                variant="secondary"
                leadingIcon={<Stethoscope className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.ficha.verHistoria')}
              </LinkButton>
            )}
            {/* El odontograma del paciente, directo a su pestaña (Fase 6B). */}
            {hasPermission('odontogram:read') && (
              <LinkButton
                to={`/consultorio?paciente=${paciente.id}&vista=odontograma`}
                variant="secondary"
                leadingIcon={<Smile className="size-4" aria-hidden="true" />}
              >
                {t('odonto.titulo')}
              </LinkButton>
            )}
            {hasPermission('patients:write') && (
              <LinkButton
                to={`/registro?documento=${encodeURIComponent(paciente.document)}`}
                variant="secondary"
                leadingIcon={<Eye className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.ficha.verEnRegistro')}
              </LinkButton>
            )}
            {hasPermission('patients:edit_sensitive') && (
              <Button
                variant="secondary"
                onClick={() => setCambiandoEstado(true)}
                leadingIcon={<ShieldAlert className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.estado.boton')}
              </Button>
            )}
            {/* Borrado lógico: solo el admin tiene `patients:delete` (ADR 0027). */}
            {hasPermission('patients:delete') && (
              <Button
                variant="danger"
                onClick={() => setBorrando(true)}
                leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.borrar.boton')}
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {paciente.isFictitious && (
            <Alert variant="warning" title={t('pacientes.ficticio')}>
              {t('pacientes.ficticioTexto')}
            </Alert>
          )}

          {/* Resumen de identificación; los datos completos, editables según el
              permiso, están en el formulario de abajo. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Dato
              etiqueta={t('pacientes.campo.birthDate')}
              valor={formatDate(paciente.birthDate)}
            />
            <Dato etiqueta={t('pacientes.campo.sex')} valor={SEX_LABELS[paciente.sex]} />
            <Dato etiqueta={t('pacientes.campo.phone')} valor={paciente.phone} />
            <Dato
              etiqueta={t('pacientes.ficha.creado')}
              valor={formatDateTime(paciente.createdAt)}
            />
            <Dato
              etiqueta={t('pacientes.ficha.actualizado')}
              valor={formatDateTime(paciente.updatedAt)}
            />
          </div>
        </CardContent>
      </Card>

      <PatientForm
        mode="edit"
        patient={paciente}
        onSaved={(actualizado: PatientDetail) => {
          cliente.setQueryData(['paciente', id], actualizado);
          refrescarLista();
          exito(t('pacientes.editar.ok'));
        }}
      />

      <PatientAttachments patientId={paciente.id} />

      {/* Fase 7B: las radiografías y fotos que se subieron en cada sesión clínica,
          con su pieza. La subida se hace desde la sesión en la que se tomaron. */}
      <PatientAttachmentsCard patientId={paciente.id} />

      {/* Las sesiones clínicas del paciente, en modo lectura: se registran en
          /consultorio y hasta ahora no había forma de volver a leerlas desde aquí. */}
      <PatientSessionsCard patientId={paciente.id} patientName={paciente.fullName} />

      <PatientStatusDialog
        open={cambiandoEstado}
        patient={paciente}
        onClose={() => setCambiandoEstado(false)}
        onDone={(actualizado: PatientDetail) => {
          cliente.setQueryData(['paciente', id], actualizado);
          refrescarLista();
          exito(t('pacientes.estado.ok'));
        }}
      />

      <PatientDeleteDialog
        open={borrando}
        patient={paciente}
        onClose={() => setBorrando(false)}
        onDone={() => {
          // El paciente desaparece de listas y búsquedas: se limpia la caché y se
          // vuelve al listado con el aviso correspondiente.
          cliente.removeQueries({ queryKey: ['paciente', id] });
          refrescarLista();
          exito(t('pacientes.borrar.ok'));
          navegar('/pacientes');
        }}
      />
    </div>
  );
};
