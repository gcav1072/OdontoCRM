import type { ClinicalSessionSummary } from '@odontocrm/contracts';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@odontocrm/ui';
import { useQuery } from '@tanstack/react-query';
import { FileClock, History } from 'lucide-react';
import { useState } from 'react';

import { sessionStatusLabel } from '../../lib/clinical-session';
import { clinicalApi } from '../../lib/endpoints';
import { formatDate, formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useAuth } from '../../providers/AuthProvider';
import { SessionReadDialog } from './SessionDetailView';

/**
 * **Las sesiones clínicas del paciente**, en su ficha (`/pacientes/:id`).
 *
 * Antes aquí solo se veía que el paciente tenía historia: las sesiones se registraban
 * en `/consultorio` y no había forma de volver a leerlas desde el paciente. Ahora se
 * listan —fecha, quién la firmó, estado y resumen— y cada una se abre en **modo
 * lectura**: una sesión cerrada no se edita (si hay que corregirla se abre una
 * enmendada con su motivo, [ADR 0034](../../../../docs/adr/0034-sesion-clinica-evolucion.md)).
 *
 * Solo se pinta para quien puede **leer** la historia (`clinical:read`): la secretaría
 * la ve para imprimir, el odontólogo para consultar.
 */
export interface PatientSessionsCardProps {
  patientId: string;
  patientName?: string | null;
}

const Fila = ({ sesion, onVer }: { sesion: ClinicalSessionSummary; onVer: () => void }) => (
  <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control border border-border px-3 py-2.5">
    <FileClock className="size-4 shrink-0 text-primary" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium text-ink">{sesion.summary}</p>
      <p className="pt-0.5 text-xs text-ink-muted">
        {formatDate(sesion.openedAt)}
        {sesion.closedAt === null ? '' : ` · ${formatDateTime(sesion.closedAt)}`}
        {sesion.closedByUsername === null ? '' : ` · ${sesion.closedByUsername}`}
        {sesion.procedureCount === 0
          ? ''
          : ` · ${t('clinica.lectura.procedimientos', { total: String(sesion.procedureCount) })}`}
      </p>
    </div>
    <Badge variant={sesion.status === 'cerrada' ? 'success' : 'warning'} dot>
      {sessionStatusLabel(sesion.status)}
    </Badge>
    <Button variant="secondary" size="sm" onClick={onVer}>
      {t('clinica.lectura.ver')}
    </Button>
  </li>
);

export const PatientSessionsCard = ({
  patientId,
  patientName = null,
}: PatientSessionsCardProps) => {
  const { hasPermission } = useAuth();
  const [abierta, setAbierta] = useState<string | null>(null);

  const puedeLeer = hasPermission('clinical:read');
  const puedeEscribir = hasPermission('clinical:write');

  const listado = useQuery({
    queryKey: ['clinical', 'sessions', patientId],
    queryFn: ({ signal }) => clinicalApi.sessions(patientId, signal),
    enabled: puedeLeer,
    staleTime: 30_000,
  });

  const detalle = useQuery({
    queryKey: ['clinical', 'session', abierta],
    queryFn: ({ signal }) => clinicalApi.getSession(abierta ?? '', signal),
    enabled: abierta !== null,
    staleTime: 30_000,
  });

  if (!puedeLeer) return null;

  const sesiones = listado.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <History className="size-4 text-primary" aria-hidden="true" />
          {t('clinica.lectura.tituloLista')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {listado.isPending && <p className="text-sm text-ink-muted">{t('comun.cargando')}</p>}

        {listado.isError && (
          <p className="text-sm text-danger">{t('clinica.lectura.errorLista')}</p>
        )}

        {!listado.isPending && !listado.isError && sesiones.length === 0 && (
          <p className="text-sm text-ink-muted">{t('clinica.lectura.sinSesiones')}</p>
        )}

        {sesiones.length > 0 && (
          <ul className="space-y-2">
            {sesiones.map((sesion) => (
              <Fila key={sesion.id} sesion={sesion} onVer={() => setAbierta(sesion.id)} />
            ))}
          </ul>
        )}
      </CardContent>

      <SessionReadDialog
        open={abierta !== null}
        sesion={detalle.data ?? null}
        cargando={detalle.isPending}
        error={detalle.isError ? t('clinica.lectura.errorDetalle') : null}
        mostrarNotasInternas={puedeEscribir}
        patientName={patientName}
        onClose={() => setAbierta(null)}
      />
    </Card>
  );
};
