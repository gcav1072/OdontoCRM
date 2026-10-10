import {
  SCREEN_TEXT_DEFINITIONS,
  type Chair,
  type ScreenTextKey,
  type ScreenTexts,
} from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Spinner,
} from '@odontocrm/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorPlay, Plus } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { agendaApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface PantallasSectionProps {
  textos: ScreenTexts;
  onTextos: (textos: ScreenTexts) => void;
  guardando: boolean;
  onGuardar: () => void;
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

const CHAIRS_KEY = ['configuracion', 'sillones'] as const;

/**
 * **Pantallas y consultorios** (ADR 0060): los textos del kiosko (un conjunto curado) y el
 * catálogo de sillones.
 *
 * Los textos se guardan con el resto del acento (`PUT /settings/app`); los sillones van
 * contra la agenda, que es su dueña (`/agenda/chairs`, permiso `scheduling:manage`). Dejar
 * un texto vacío lo devuelve al de fábrica.
 */
export const PantallasSection = ({
  textos,
  onTextos,
  guardando,
  onGuardar,
  onNotice,
}: PantallasSectionProps) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <MonitorPlay className="size-4 text-primary" aria-hidden="true" />
          {t('config.pantallas.titulo')}
        </CardTitle>
        <CardDescription>{t('config.pantallas.textosAyuda')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('config.pantallas.textos')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {SCREEN_TEXT_DEFINITIONS.map((definicion) => (
              <Field
                key={definicion.key}
                label={definicion.label}
                hint={
                  definicion.placeholders.length === 0
                    ? undefined
                    : `Marcadores: ${definicion.placeholders.map((p) => `{${p}}`).join(', ')}`
                }
              >
                <Input
                  value={textos[definicion.key] ?? ''}
                  placeholder={t(definicion.key as ScreenTextKey)}
                  onChange={(event) => {
                    const valor = event.target.value;
                    const siguiente: ScreenTexts = { ...textos };
                    if (valor.trim() === '') delete siguiente[definicion.key];
                    else siguiente[definicion.key] = valor;
                    onTextos(siguiente);
                  }}
                />
              </Field>
            ))}
          </div>
          <Button loading={guardando} loadingLabel={t('comun.guardando')} onClick={onGuardar}>
            {t('comun.guardar')}
          </Button>
        </section>

        <Sillones onNotice={onNotice} />
      </CardContent>
    </Card>
  );
};

/** El catálogo de sillones: qué consultorio ocupa cada franja (ADR 0059). */
const Sillones = ({
  onNotice,
}: {
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}) => {
  const consultas = useQueryClient();
  const [nuevo, setNuevo] = useState('');

  const query = useQuery({
    queryKey: CHAIRS_KEY,
    queryFn: ({ signal }) => agendaApi.chairs({ todos: true }, signal),
  });

  const crear = useMutation({
    mutationFn: (label: string) =>
      agendaApi.createChair({ label, shortLabel: null, isActive: true, sortOrder: 0 }),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: CHAIRS_KEY });
      setNuevo('');
      onNotice('success', t('config.pantallas.sillonCreado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const sillones = query.data?.items ?? [];

  return (
    <section className="space-y-3 border-t border-border pt-5">
      <h3 className="text-sm font-semibold text-ink">{t('config.pantallas.sillones')}</h3>
      <p className="text-sm text-ink-muted">{t('config.pantallas.sillonesAyuda')}</p>

      {query.isError ? (
        <Alert variant="danger" title={t('config.error')}>
          {apiErrorMessage(query.error)}
        </Alert>
      ) : query.isPending ? (
        <Spinner label={t('comun.cargando')} showLabel />
      ) : (
        <ul className="space-y-2">
          {sillones.map((sillon) => (
            <FilaSillon key={sillon.id} sillon={sillon} onNotice={onNotice} />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('config.pantallas.sillonNombre')}>
          <Input
            value={nuevo}
            onChange={(event) => setNuevo(event.target.value)}
            className="max-w-64"
          />
        </Field>
        <Button
          loading={crear.isPending}
          disabled={nuevo.trim().length < 1}
          onClick={() => crear.mutate(nuevo.trim())}
          leadingIcon={<Plus className="size-4" aria-hidden="true" />}
        >
          {t('config.pantallas.anadirSillon')}
        </Button>
      </div>
    </section>
  );
};

/** Un sillón editable en la lista. */
const FilaSillon = ({
  sillon,
  onNotice,
}: {
  sillon: Chair;
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}) => {
  const consultas = useQueryClient();
  const [label, setLabel] = useState(sillon.label);
  const [shortLabel, setShortLabel] = useState(sillon.shortLabel ?? '');
  const [sortOrder, setSortOrder] = useState(sillon.sortOrder);

  const guardar = useMutation({
    mutationFn: () =>
      agendaApi.updateChair(sillon.id, {
        label,
        shortLabel: shortLabel.trim() === '' ? null : shortLabel.trim(),
        sortOrder,
      }),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: CHAIRS_KEY });
      onNotice('success', t('config.pantallas.sillonGuardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const activar = useMutation({
    mutationFn: (isActive: boolean) => agendaApi.updateChair(sillon.id, { isActive }),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: CHAIRS_KEY });
      onNotice('success', t('config.pantallas.sillonGuardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const cambiado =
    label !== sillon.label ||
    shortLabel !== (sillon.shortLabel ?? '') ||
    sortOrder !== sillon.sortOrder;

  return (
    <li className="flex flex-wrap items-end gap-3 rounded-control border border-border px-3 py-2">
      <Field label={t('config.pantallas.sillonNombre')}>
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="max-w-56"
        />
      </Field>
      <Field label={t('config.pantallas.sillonCorto')}>
        <Input
          value={shortLabel}
          onChange={(event) => setShortLabel(event.target.value)}
          className="max-w-24"
        />
      </Field>
      <Field label={t('config.pantallas.sillonOrden')}>
        <Input
          type="number"
          value={sortOrder}
          onChange={(event) => setSortOrder(Number(event.target.value))}
          className="max-w-20"
        />
      </Field>
      <Badge variant={sillon.isActive ? 'success' : 'neutral'} dot>
        {sillon.isActive ? t('comun.si') : t('comun.no')}
      </Badge>
      <Button
        size="sm"
        loading={guardar.isPending}
        disabled={!cambiado || label.trim() === ''}
        onClick={() => guardar.mutate()}
      >
        {t('comun.guardar')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={activar.isPending}
        onClick={() => activar.mutate(!sillon.isActive)}
      >
        {sillon.isActive ? t('pantallas.inactiva') : t('pantallas.activa')}
      </Button>
    </li>
  );
};
