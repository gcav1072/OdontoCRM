import { AUDIT_ACTIONS } from '@odontocrm/contracts';
import { Button, Field, Input, Select } from '@odontocrm/ui';
import { RotateCcw } from 'lucide-react';

import {
  actionLabel,
  entityTypeOptions,
  hasActiveFilters,
  type AuditFilterState,
} from '../../lib/audit';
import { t } from '../../lib/i18n';

export interface AuditFiltersProps {
  value: AuditFilterState;
  onChange: (next: AuditFilterState) => void;
  onClear: () => void;
}

/**
 * Barra de filtros de la auditoría: rango de fechas, usuario, acción, tipo de
 * entidad, identificador y campo.
 *
 * No hay botón «Buscar»: cada control aplica su filtro al cambiar (los textos
 * libres se difieren en la página para no consultar por tecla). La etiqueta de
 * cada campo es real (`Field` la ata al control con `htmlFor`), así que la barra
 * se recorre entera con el teclado.
 */
export const AuditFilters = ({ value, onChange, onClear }: AuditFiltersProps) => {
  const cambiar = (parcial: Partial<AuditFilterState>): void => onChange({ ...value, ...parcial });

  // Un rango invertido se avisa pero no se bloquea: la consulta devolverá vacío
  // y la persona corrige la fecha viendo el mensaje.
  const rangoInvalido =
    value.desde.trim() !== '' && value.hasta.trim() !== '' && value.desde > value.hasta;

  const opcionesEntidad = entityTypeOptions();

  return (
    <div
      role="search"
      aria-label={t('auditoria.filtros')}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Field label={t('auditoria.filtro.desde')} hint={t('auditoria.filtro.fechaAyuda')}>
        <Input
          type="date"
          value={value.desde}
          invalid={rangoInvalido}
          max={value.hasta === '' ? undefined : value.hasta}
          onChange={(event) => cambiar({ desde: event.target.value })}
        />
      </Field>

      <Field
        label={t('auditoria.filtro.hasta')}
        error={rangoInvalido ? t('auditoria.filtro.rangoInvalido') : undefined}
      >
        <Input
          type="date"
          value={value.hasta}
          invalid={rangoInvalido}
          min={value.desde === '' ? undefined : value.desde}
          onChange={(event) => cambiar({ hasta: event.target.value })}
        />
      </Field>

      <Field label={t('auditoria.filtro.usuario')}>
        <Input
          type="search"
          value={value.usuario}
          placeholder={t('auditoria.filtro.usuarioPlaceholder')}
          onChange={(event) => cambiar({ usuario: event.target.value })}
        />
      </Field>

      <Field label={t('auditoria.filtro.accion')}>
        <Select value={value.accion} onChange={(event) => cambiar({ accion: event.target.value })}>
          <option value="">{t('auditoria.filtro.todasAcciones')}</option>
          {AUDIT_ACTIONS.map((accion) => (
            <option key={accion} value={accion}>
              {actionLabel(accion)}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t('auditoria.filtro.entidad')}>
        <Select
          value={value.tipoEntidad}
          onChange={(event) => cambiar({ tipoEntidad: event.target.value })}
        >
          <option value="">{t('auditoria.filtro.todasEntidades')}</option>
          {opcionesEntidad.map((opcion) => (
            <option key={opcion.value} value={opcion.value}>
              {opcion.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t('auditoria.filtro.identificador')}>
        <Input
          value={value.identificador}
          placeholder={t('auditoria.filtro.identificadorPlaceholder')}
          className="font-mono text-xs"
          onChange={(event) => cambiar({ identificador: event.target.value })}
        />
      </Field>

      <Field label={t('auditoria.filtro.campo')}>
        <Input
          value={value.campo}
          placeholder={t('auditoria.filtro.campoPlaceholder')}
          className="font-mono text-xs"
          onChange={(event) => cambiar({ campo: event.target.value })}
        />
      </Field>

      <div className="flex items-end">
        <Button
          variant="secondary"
          onClick={onClear}
          disabled={!hasActiveFilters(value)}
          leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
        >
          {t('comun.limpiar')}
        </Button>
      </div>
    </div>
  );
};
