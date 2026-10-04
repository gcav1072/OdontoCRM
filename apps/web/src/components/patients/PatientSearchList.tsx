import type { PatientSummary } from '@odontocrm/contracts';
import { Alert, Badge, EmptyState, Input, Spinner } from '@odontocrm/ui';
import { useQuery } from '@tanstack/react-query';
import { ContactRound, Search } from 'lucide-react';
import { useState } from 'react';

import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { apiErrorMessage } from '../../lib/api';
import { patientsApi } from '../../lib/endpoints';
import { SEX_LABELS, t } from '../../lib/i18n';

/**
 * Buscador de pacientes por nombre, documento o teléfono, con la lista de
 * resultados ya lista para pulsar.
 *
 * Vive aparte porque lo usan dos sitios con envoltorios distintos: la tarjeta
 * «Elegir paciente» de `/consultorio` y el diálogo del atajo `F2` de `/flujo`.
 * La consulta se difiere para no pedir en cada tecla.
 */
export interface PatientSearchListProps {
  onSelect: (patient: PatientSummary) => void;
  /** Resultados que se piden de una vez (el diálogo del flujo pide menos). */
  pageSize?: number;
  /** Mensaje del estado vacío cuando la búsqueda no encuentra nada. */
  emptyTitle?: string;
  /** El atajo `F2` abre el buscador para escribir ya; la tarjeta no lo roba. */
  autoFocus?: boolean;
}

const parseSex = (value: string): string =>
  value === 'M' || value === 'F' || value === 'O' ? SEX_LABELS[value] : value;

export const PatientSearchList = ({
  onSelect,
  pageSize = 10,
  emptyTitle,
  autoFocus = false,
}: PatientSearchListProps) => {
  const [busqueda, setBusqueda] = useState('');
  const diferida = useDebouncedValue(busqueda, 350);

  const pacientesQuery = useQuery({
    queryKey: ['clinica', 'selector-paciente', diferida, pageSize],
    queryFn: ({ signal }) =>
      patientsApi.list(
        {
          search: diferida.trim() === '' ? undefined : diferida.trim(),
          page: 1,
          pageSize,
        },
        signal,
      ),
  });

  const pacientes = pacientesQuery.data?.items ?? [];

  return (
    <div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
          aria-hidden
        />
        <Input
          autoFocus={autoFocus}
          className="pl-9"
          value={busqueda}
          aria-label={t('clinica.selector.placeholder')}
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
            title={emptyTitle ?? t('clinica.selector.vacio')}
            description={t('clinica.selector.vacioTexto')}
          />
        )}
        {pacientes.length > 0 && (
          <ul className="divide-y divide-border rounded-control border border-border">
            {pacientes.map((paciente) => (
              <li key={paciente.id}>
                <button
                  type="button"
                  onClick={() => onSelect(paciente)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-muted"
                >
                  <span>
                    <span className="block text-sm font-medium text-ink">{paciente.fullName}</span>
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
    </div>
  );
};
