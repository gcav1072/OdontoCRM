import type { BotStatus, PatientChannel, PatientSummary } from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Field,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@odontocrm/ui';
import { Check, Copy, Link2, Plug, QrCode, Search, Unlink, UserRound } from 'lucide-react';
import { useState } from 'react';

import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { apiErrorMessage } from '../../lib/api';
import {
  notificationsApi,
  patientsApi,
  type LinkCodeResponse,
  type PatientChannelList,
} from '../../lib/endpoints';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { linkCodeExpired, notificationKeys, notificationQrImage } from '../../lib/notifications';
import { DescriptionList } from './DescriptionList';

export interface PatientChannelCardProps {
  bot: BotStatus | undefined;
  /** `scheduling:notify`: sin él se ve todo, pero no se genera ni se desvincula. */
  canNotify: boolean;
  onNotice: (variant: 'success' | 'danger' | 'info', message: string) => void;
}

/**
 * Vinculación de pacientes (Fase 4): se busca al paciente, se genera su enlace
 * (`POST /channels/link-code`), y se muestra el QR, el `deep link` y la fecha de
 * caducidad. Debajo, los canales ya vinculados con la opción de desvincular.
 *
 * La vinculación real la hace el paciente: abre el enlace o escanea el QR y su
 * chat de Telegram queda asociado a su ficha.
 */
export const PatientChannelCard = ({ bot, canNotify, onNotice }: PatientChannelCardProps) => {
  const cliente = useQueryClient();
  const [busqueda, setBusqueda] = useState('');
  const [paciente, setPaciente] = useState<PatientSummary | null>(null);
  const [enlace, setEnlace] = useState<LinkCodeResponse | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [desvinculando, setDesvinculando] = useState<PatientChannel | null>(null);

  const busquedaDiferida = useDebouncedValue(busqueda, 350);

  const pacientesQuery = useQuery({
    queryKey: ['pacientes', 'notificaciones', { busqueda: busquedaDiferida }],
    queryFn: ({ signal }) =>
      patientsApi.list(
        {
          search: busquedaDiferida.trim() === '' ? undefined : busquedaDiferida.trim(),
          page: 1,
          pageSize: 6,
        },
        signal,
      ),
  });

  const canalesQuery = useQuery({
    queryKey: notificationKeys.channels(null),
    queryFn: ({ signal }) => notificationsApi.channels(undefined, signal),
  });

  const generar = useMutation({
    mutationFn: (patientId: string) => notificationsApi.linkCode(patientId),
    onSuccess: (generado) => {
      setEnlace(generado);
      setCopiado(false);
      onNotice(
        'success',
        t('notificaciones.canales.generado', {
          paciente: paciente?.fullName ?? t('comun.desconocido'),
        }),
      );
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const desvincular = useMutation({
    mutationFn: (patientId: string) => notificationsApi.unlinkChannel(patientId),
    onSuccess: (_resultado, patientId) => {
      setDesvinculando(null);
      cliente.setQueryData<PatientChannelList>(notificationKeys.channels(null), (actual) =>
        actual === undefined
          ? actual
          : {
              items: actual.items.filter((canal) => canal.patientId !== patientId),
              total: Math.max(0, actual.total - 1),
            },
      );
      void cliente.invalidateQueries({ queryKey: notificationKeys.status });
      onNotice('success', t('notificaciones.canales.desvinculado'));
    },
    onError: (fallo) => {
      setDesvinculando(null);
      onNotice('danger', apiErrorMessage(fallo));
    },
  });

  const elegir = (elegido: PatientSummary) => {
    setPaciente(elegido);
    setEnlace(null);
    setCopiado(false);
    setBusqueda('');
  };

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      onNotice('success', t('notificaciones.canales.copiado'));
    } catch {
      onNotice('danger', t('notificaciones.canales.copiarError'));
    }
  };

  const qr = notificationQrImage(enlace?.qrDataUrl);
  const caducado = enlace !== null && linkCodeExpired(enlace.expiresAt);
  const sinToken = bot !== undefined && (bot.mode === 'simulado' || bot.botUsername === null);
  const canales = canalesQuery.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <QrCode className="size-4 text-primary" aria-hidden="true" />
          {t('notificaciones.canales.titulo')}
        </CardTitle>
        <p className="text-sm text-ink-muted">{t('notificaciones.canales.descripcion')}</p>
      </CardHeader>

      <CardContent className="space-y-5">
        {sinToken && (
          <Alert variant="warning" title={t('notificaciones.bot.modo.simulado')}>
            {t('notificaciones.canales.noDisponible')}
          </Alert>
        )}

        {paciente === null ? (
          <div className="space-y-3">
            <Field label={t('notificaciones.canales.buscar')}>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  className="pl-9"
                  placeholder={t('notificaciones.canales.buscarPlaceholder')}
                  value={busqueda}
                  onChange={(event) => setBusqueda(event.target.value)}
                />
              </div>
            </Field>

            {pacientesQuery.isError ? (
              <Alert variant="danger" title={t('notificaciones.canales.errorBusqueda')}>
                {apiErrorMessage(pacientesQuery.error)}
              </Alert>
            ) : pacientesQuery.isFetching && busquedaDiferida.trim() !== '' ? (
              <Spinner label={t('notificaciones.canales.buscando')} showLabel />
            ) : busquedaDiferida.trim() === '' ? (
              <p className="text-sm text-ink-muted">{t('notificaciones.canales.sinPaciente')}</p>
            ) : (pacientesQuery.data?.items.length ?? 0) === 0 ? (
              <Alert variant="info">{t('notificaciones.canales.sinResultados')}</Alert>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {pacientesQuery.data?.items.map((encontrado) => (
                  <li key={encontrado.id}>
                    <button
                      type="button"
                      onClick={() => elegir(encontrado)}
                      className={cn(
                        'flex w-full flex-wrap items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-muted',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
                      )}
                    >
                      <UserRound className="size-4 text-ink-subtle" aria-hidden="true" />
                      <span className="text-sm font-medium text-ink">{encontrado.fullName}</span>
                      <span className="font-mono text-xs text-ink-subtle">
                        {encontrado.document}
                      </span>
                      <span className="text-xs text-ink-subtle">{encontrado.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="primary" icon={<UserRound className="size-3.5" aria-hidden="true" />}>
                {paciente.fullName}
              </Badge>
              <span className="font-mono text-xs text-ink-subtle">{paciente.document}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPaciente(null);
                  setEnlace(null);
                }}
              >
                {t('notificaciones.canales.cambiar')}
              </Button>
            </div>

            {canNotify ? (
              <Button
                loading={generar.isPending}
                loadingLabel={t('notificaciones.canales.generando')}
                leadingIcon={<Link2 className="size-4" aria-hidden="true" />}
                onClick={() => generar.mutate(paciente.id)}
              >
                {t('notificaciones.canales.generar')}
              </Button>
            ) : (
              <Alert variant="info">{t('notificaciones.soloLectura')}</Alert>
            )}

            {enlace !== null && (
              <div className="grid gap-4 rounded-control border border-border bg-surface-muted/50 p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                <div className="flex flex-col items-center gap-2">
                  {qr === null ? (
                    <Alert variant="info" className="max-w-xs">
                      {t('notificaciones.canales.sinQr')}
                    </Alert>
                  ) : (
                    <img
                      src={qr}
                      alt={t('notificaciones.canales.qrAlt', { paciente: paciente.fullName })}
                      width={180}
                      height={180}
                      className="rounded-control border border-border bg-surface p-2"
                    />
                  )}
                  <span className="font-mono text-xs text-ink-subtle">{enlace.code}</span>
                </div>

                <div className="min-w-0 space-y-3">
                  <p className="text-sm text-ink">{t('notificaciones.canales.instruccion')}</p>

                  <DescriptionList
                    columns={1}
                    items={[
                      [
                        t('notificaciones.canales.enlace'),
                        <span className="flex flex-wrap items-center gap-2">
                          <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted">
                            {enlace.deepLink === '' ? t('comun.sinDato') : enlace.deepLink}
                          </code>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={enlace.deepLink === ''}
                            leadingIcon={
                              copiado ? (
                                <Check className="size-3.5" aria-hidden="true" />
                              ) : (
                                <Copy className="size-3.5" aria-hidden="true" />
                              )
                            }
                            onClick={() => void copiar(enlace.deepLink)}
                          >
                            {copiado ? t('comun.copiado') : t('notificaciones.canales.copiar')}
                          </Button>
                        </span>,
                      ],
                      [
                        t('notificaciones.canales.codigo'),
                        <span className="font-mono text-sm">{enlace.code}</span>,
                      ],
                      [
                        t('notificaciones.canales.caduca'),
                        <span className={caducado ? 'text-danger' : undefined}>
                          {formatDateTime(enlace.expiresAt)}
                        </span>,
                      ],
                      [
                        t('notificaciones.bot.titulo'),
                        <span className="font-mono text-sm">
                          {enlace.botUsername === null
                            ? t('notificaciones.bot.sinUsuario')
                            : `@${enlace.botUsername}`}
                        </span>,
                      ],
                    ]}
                  />

                  {caducado && (
                    <Alert variant="warning">{t('notificaciones.canales.expirado')}</Alert>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Plug className="size-4 text-primary" aria-hidden="true" />
              {t('notificaciones.canales.listaTitulo')}
            </h3>
            <p className="text-sm text-ink-muted">{t('notificaciones.canales.listaTexto')}</p>
          </div>

          {canalesQuery.isError && (
            <Alert variant="danger" title={t('notificaciones.canales.errorLista')}>
              {apiErrorMessage(canalesQuery.error)}
            </Alert>
          )}

          {canalesQuery.isPending ? (
            <Spinner label={t('notificaciones.canales.cargando')} showLabel />
          ) : canales.length === 0 ? (
            <EmptyState
              icon={<Plug className="size-6" aria-hidden="true" />}
              title={t('notificaciones.canales.listaTitulo')}
              description={t('notificaciones.canales.vacio')}
            />
          ) : (
            <Table caption={t('notificaciones.canales.total', { total: canales.length })}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('notificaciones.canales.columna.paciente')}</TableHead>
                  <TableHead>{t('notificaciones.canales.columna.chat')}</TableHead>
                  <TableHead>{t('notificaciones.canales.columna.usuario')}</TableHead>
                  <TableHead>{t('notificaciones.canales.columna.vinculado')}</TableHead>
                  <TableHead className="text-right">
                    {t('notificaciones.canales.columna.acciones')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {canales.map((canal) => (
                  <TableRow key={canal.patientId}>
                    <TableCell className="text-sm text-ink">
                      {canal.patientName ?? t('comun.desconocido')}
                      {canal.isBlocked && (
                        <Badge variant="neutral" className="ml-2">
                          {t('notificaciones.canales.bloqueado')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-ink-muted">
                      {canal.chatIdMasked}
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">
                      {canal.telegramUsername === null
                        ? t('comun.sinDato')
                        : `@${canal.telegramUsername}`}
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">
                      {canal.linkedAt === null
                        ? t('comun.sinDato')
                        : formatDateTime(canal.linkedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {canNotify && (
                        <Button
                          size="sm"
                          variant="ghost"
                          leadingIcon={<Unlink className="size-3.5" aria-hidden="true" />}
                          onClick={() => setDesvinculando(canal)}
                        >
                          {t('notificaciones.canales.desvincular')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>

      {desvinculando !== null && (
        <Dialog
          open
          onClose={() => setDesvinculando(null)}
          size="sm"
          title={t('notificaciones.canales.desvincularTitulo', {
            paciente: desvinculando.patientName ?? t('comun.desconocido'),
          })}
          dismissOnBackdrop={false}
          closeLabel={t('comun.cerrar')}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDesvinculando(null)}
                disabled={desvincular.isPending}
              >
                {t('comun.cancelar')}
              </Button>
              <Button
                variant="danger"
                loading={desvincular.isPending}
                onClick={() => desvincular.mutate(desvinculando.patientId)}
              >
                {t('notificaciones.canales.desvincular')}
              </Button>
            </>
          }
        >
          <Alert variant="warning">{t('notificaciones.canales.desvincularTexto')}</Alert>
        </Dialog>
      )}
    </Card>
  );
};
