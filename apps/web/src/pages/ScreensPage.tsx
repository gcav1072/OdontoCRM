import type { DeviceTokenCreated, ScreenDevice } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import { Ban, HelpCircle, Plus, Settings2, Tv } from 'lucide-react';
import { useState } from 'react';

import { NoticeBanner } from '../components/NoticeBanner';
import { DeactivateScreenDialog } from '../components/screens/DeactivateScreenDialog';
import { NewScreenDialog } from '../components/screens/NewScreenDialog';
import { ScreenSettingsDialog } from '../components/screens/ScreenSettingsDialog';
import { ScreenTokenDialog } from '../components/screens/ScreenTokenDialog';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { screensApi } from '../lib/endpoints';
import { formatDateTime, formatRelative } from '../lib/format';
import { t } from '../lib/i18n';
import { kioskUrl, screenKeys } from '../lib/screens';

/** Diálogo abierto en cada momento (uno a la vez). */
type DialogoState =
  | { tipo: 'ninguno' }
  | { tipo: 'crear' }
  | { tipo: 'ajustes'; pantalla: ScreenDevice }
  | { tipo: 'desactivar'; pantalla: ScreenDevice }
  /** El token se enseña una sola vez: este estado solo dura hasta cerrarlo. */
  | { tipo: 'token'; label: string; token: DeviceTokenCreated };

/**
 * `/pantallas` (Fase 5): administración de los televisores de la clínica.
 *
 * Se registra cada pantalla (nombre y tipo), se ajusta su voz y su tiempo de
 * resalte, se desactiva cuando se retira y se ve cuáles están conectadas ahora
 * mismo. El **token de dispositivo se muestra una sola vez**, al registrar la
 * pantalla: el servidor solo guarda su hash, así que si se pierde hay que
 * registrar la pantalla de nuevo (el diálogo lo avisa).
 */
export const ScreensPage = () => {
  const { notice, mostrar, exito, limpiar } = useNotice();
  const [dialogo, setDialogo] = useState<DialogoState>({ tipo: 'ninguno' });

  const pantallasQuery = useQuery({
    queryKey: screenKeys.devices,
    queryFn: ({ signal }) => screensApi.devices(signal),
  });

  // Cuántas pantallas tienen el flujo abierto en este momento. Es informativo:
  // si falla, la tabla sigue siendo útil y se muestra el aviso de la tabla.
  const conectadasQuery = useQuery({
    queryKey: screenKeys.conectadas,
    queryFn: ({ signal }) => screensApi.conectadas(signal),
    refetchInterval: 30_000,
  });

  const pantallas = pantallasQuery.data?.items ?? [];
  const conectadas = (conectadasQuery.data?.lobby ?? 0) + (conectadasQuery.data?.consultorio ?? 0);

  /** Cierra el diálogo de ajustes/desactivar avisando del resultado. */
  const trasAccion = (mensaje: string, nombre: string) => {
    void pantallasQuery.refetch();
    void conectadasQuery.refetch();
    exito(`${nombre}: ${mensaje}`);
  };

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <CardTitle as="h2" className="flex items-center gap-2">
              <Tv className="size-4 text-primary" aria-hidden="true" />
              {t('pantallas.titulo')}
            </CardTitle>
            <p className="pt-1 text-sm text-ink-muted">{t('pantallas.descripcion')}</p>
          </div>
          <Button
            onClick={() => setDialogo({ tipo: 'crear' })}
            leadingIcon={<Plus className="size-4" aria-hidden="true" />}
          >
            {t('pantallas.nueva')}
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={conectadas > 0 ? 'success' : 'neutral'} dot>
              {t('pantallas.conectadas', { total: conectadas })}
            </Badge>
            {conectadasQuery.isError && (
              <span className="text-xs text-ink-subtle">
                {apiErrorMessage(conectadasQuery.error)}
              </span>
            )}
          </div>

          {pantallasQuery.isError ? (
            <Alert variant="danger" title={t('pantallas.errorCargar')}>
              {apiErrorMessage(pantallasQuery.error)}
            </Alert>
          ) : pantallasQuery.isPending ? (
            <div className="py-10">
              <Spinner label={t('pantallas.cargando')} showLabel />
            </div>
          ) : pantallas.length === 0 ? (
            <EmptyState
              icon={<Tv className="size-6" aria-hidden="true" />}
              title={t('pantallas.titulo')}
              description={t('pantallas.vacio')}
              action={
                <Button
                  onClick={() => setDialogo({ tipo: 'crear' })}
                  leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                >
                  {t('pantallas.nueva')}
                </Button>
              }
            />
          ) : (
            <Table caption={t('pantallas.conectadas', { total: conectadas })}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('pantallas.columna.nombre')}</TableHead>
                  <TableHead>{t('pantallas.columna.tipo')}</TableHead>
                  <TableHead>{t('pantallas.columna.estado')}</TableHead>
                  <TableHead>{t('pantallas.columna.visto')}</TableHead>
                  <TableHead className="text-right">{t('pantallas.columna.acciones')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pantallas.map((pantalla) => (
                  <TableRow key={pantalla.id}>
                    <TableCell>
                      <span className="block font-medium text-ink">{pantalla.label}</span>
                      <span className="block font-mono text-xs text-ink-subtle">{pantalla.id}</span>
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">
                      {t(`pantallas.tipo.${pantalla.kind}`)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={pantalla.isActive ? 'success' : 'neutral'} dot>
                        {pantalla.isActive ? t('pantallas.activa') : t('pantallas.inactiva')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {pantalla.lastSeenAt === null ? (
                        <span className="text-sm text-ink-subtle">{t('pantallas.nuncaVista')}</span>
                      ) : (
                        <>
                          <span
                            className="block text-sm"
                            title={formatDateTime(pantalla.lastSeenAt)}
                          >
                            {formatRelative(pantalla.lastSeenAt)}
                          </span>
                          <span className="block text-xs text-ink-subtle">
                            {formatDateTime(pantalla.lastSeenAt)}
                          </span>
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className="flex items-center justify-end gap-1"
                        aria-label={t('pantallas.columna.acciones')}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          title={t('pantallas.ajustes')}
                          aria-label={t('pantallas.ajustes')}
                          onClick={() => setDialogo({ tipo: 'ajustes', pantalla })}
                          leadingIcon={<Settings2 className="size-4" aria-hidden="true" />}
                        />
                        {/* Una pantalla ya desactivada no se vuelve a activar
                            desde aquí: su token está revocado y hay que
                            registrarla de nuevo (lo dice `pantallas.ayuda`). */}
                        {pantalla.isActive && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('pantallas.desactivar.titulo', { pantalla: pantalla.label })}
                            aria-label={t('pantallas.desactivar.titulo', {
                              pantalla: pantalla.label,
                            })}
                            onClick={() => setDialogo({ tipo: 'desactivar', pantalla })}
                            leadingIcon={<Ban className="size-4" aria-hidden="true" />}
                          />
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            <HelpCircle className="size-4 text-primary" aria-hidden="true" />
            {t('pantallas.ayuda.titulo')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-muted">{t('pantallas.ayuda.texto')}</p>
        </CardContent>
      </Card>

      <NewScreenDialog
        open={dialogo.tipo === 'crear'}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
        onCreated={({ label, token }) => {
          // El aviso se muestra **antes** de abrir el token: es el único momento
          // en el que se puede copiar el enlace.
          mostrar({
            variant: 'success',
            message: t('pantallas.creada', { pantalla: label }),
          });
          setDialogo({ tipo: 'token', label, token });
        }}
      />

      <ScreenSettingsDialog
        pantalla={dialogo.tipo === 'ajustes' ? dialogo.pantalla : null}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
        onSaved={(mensaje, nombre) => trasAccion(mensaje, nombre)}
      />

      <DeactivateScreenDialog
        pantalla={dialogo.tipo === 'desactivar' ? dialogo.pantalla : null}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
        onDone={(mensaje, nombre) => trasAccion(mensaje, nombre)}
      />

      {dialogo.tipo === 'token' && (
        <ScreenTokenDialog
          label={dialogo.label}
          url={kioskUrl(dialogo.token.kind, dialogo.token.token)}
          onClose={() => {
            // Cerrado el aviso, el token desaparece de la interfaz para siempre.
            setDialogo({ tipo: 'ninguno' });
          }}
        />
      )}
    </div>
  );
};
