import type { NotificationRecord } from '@odontocrm/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { NoticeBanner } from '../components/NoticeBanner';
import { BotConversationsCard } from '../components/notifications/BotConversationsCard';
import { BotStatusCard } from '../components/notifications/BotStatusCard';
import { ContactedDialog } from '../components/notifications/ContactedDialog';
import { MessageTemplatesCard } from '../components/notifications/MessageTemplatesCard';
import { NotificationDetailDialog } from '../components/notifications/NotificationDetailDialog';
import {
  NotificationsTable,
  type NotificationFiltersState,
} from '../components/notifications/NotificationsTable';
import { PatientChannelCard } from '../components/notifications/PatientChannelCard';
import { RetryNotificationDialog } from '../components/notifications/RetryNotificationDialog';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useNotice } from '../hooks/useNotice';
import { notificationsApi } from '../lib/endpoints';
import { t } from '../lib/i18n';
import { BOT_STATUS_REFRESH_MS, notificationKeys } from '../lib/notifications';
import { useAuth } from '../providers/AuthProvider';

const FILTROS_INICIALES: NotificationFiltersState = {
  status: '',
  channel: '',
  from: '',
  to: '',
};

/**
 * `/notificaciones` (Fase 4): la bandeja del bot de Telegram.
 *
 * - Cabecera de estado con el modo (`real` o `simulado`), la conexión, las
 *   actualizaciones pendientes y los contadores. Se refresca sola cada 15 s.
 * - Bandeja de envíos con filtros, paginación y, por fila, reintento, contacto
 *   manual y detalle del mensaje.
 * - Conversaciones activas del asistente (informativas).
 * - Plantillas editables con marcadores y vista previa.
 * - Vinculación de pacientes con enlace, QR y desvinculación.
 *
 * Ver la pantalla exige `scheduling:read`; las acciones de escritura exigen
 * `scheduling:notify` y se comprueban aquí además de en la API. Las mutaciones
 * viven en sus diálogos y la página solo decide qué invalidar tras cada una.
 */
export const NotificationsPage = () => {
  const { hasPermission } = useAuth();
  const cliente = useQueryClient();
  const { notice, mostrar, exito, limpiar } = useNotice();

  const puedeNotificar = hasPermission('scheduling:notify');

  const [filtros, setFiltros] = useState<NotificationFiltersState>(FILTROS_INICIALES);
  const [busqueda, setBusqueda] = useState('');
  const [pagina, setPagina] = useState(1);
  const [reintentando, setReintentando] = useState<NotificationRecord | null>(null);
  const [contactando, setContactando] = useState<NotificationRecord | null>(null);
  const [detalle, setDetalle] = useState<NotificationRecord | null>(null);
  const [momentoEstado, setMomentoEstado] = useState<number | null>(null);

  const busquedaDiferida = useDebouncedValue(busqueda, 350);
  const busquedaPrevia = useRef(busquedaDiferida);

  // Cambiar cualquier filtro devuelve a la primera página.
  useEffect(() => {
    setPagina(1);
  }, [filtros]);

  // La búsqueda se difiere, así que su propia pausa decide cuándo volver a la 1.
  useEffect(() => {
    if (busquedaPrevia.current !== busquedaDiferida) {
      busquedaPrevia.current = busquedaDiferida;
      setPagina(1);
    }
  }, [busquedaDiferida]);

  const estadoQuery = useQuery({
    queryKey: notificationKeys.status,
    queryFn: ({ signal }) => notificationsApi.status(signal),
    refetchInterval: BOT_STATUS_REFRESH_MS,
  });

  useEffect(() => {
    if (estadoQuery.dataUpdatedAt > 0) setMomentoEstado(estadoQuery.dataUpdatedAt);
  }, [estadoQuery.dataUpdatedAt]);

  /** Tras mover un envío cambian la bandeja y los contadores del bot. */
  const invalidarTrasEnvio = () => {
    void cliente.invalidateQueries({ queryKey: notificationKeys.listRoot });
    void cliente.invalidateQueries({ queryKey: notificationKeys.status });
  };

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <Bot className="size-5 text-primary" aria-hidden="true" />
          {t('notificaciones.titulo')}
        </h1>
        <p className="pt-1 text-sm text-ink-muted">{t('notificaciones.descripcion')}</p>
      </header>

      <BotStatusCard
        status={estadoQuery.data}
        updatedAt={momentoEstado}
        isPending={estadoQuery.isPending}
        isFetching={estadoQuery.isFetching}
        error={estadoQuery.error}
        onReload={() => void estadoQuery.refetch()}
      />

      <BotConversationsCard
        conversations={estadoQuery.data?.conversations}
        isPending={estadoQuery.isPending}
        error={estadoQuery.error}
      />

      <NotificationsTable
        filters={filtros}
        onFiltersChange={setFiltros}
        /* Se pasa el texto ya diferido: si viajara el de cada tecla, la consulta
           cambiaría de clave en cada pulsación y la búsqueda no se ahorraría. */
        search={busquedaDiferida}
        onSearchChange={setBusqueda}
        page={pagina}
        onPageChange={setPagina}
        canNotify={puedeNotificar}
        onRetry={setReintentando}
        onContact={setContactando}
        onDetail={setDetalle}
      />

      <MessageTemplatesCard
        canNotify={puedeNotificar}
        onSaved={exito}
        onError={(mensaje) => mostrar({ variant: 'danger', message: mensaje })}
      />

      <PatientChannelCard
        bot={estadoQuery.data}
        canNotify={puedeNotificar}
        onNotice={(variant, message) => mostrar({ variant, message })}
      />

      {reintentando !== null && (
        <RetryNotificationDialog
          record={reintentando}
          onClose={() => setReintentando(null)}
          onRetried={() => {
            setReintentando(null);
            invalidarTrasEnvio();
            exito(t('notificaciones.reintento.ok'));
          }}
        />
      )}

      {contactando !== null && (
        <ContactedDialog
          record={contactando}
          onClose={() => setContactando(null)}
          onContacted={() => {
            setContactando(null);
            invalidarTrasEnvio();
            exito(t('notificaciones.contacto.ok'));
          }}
        />
      )}

      {detalle !== null && (
        <NotificationDetailDialog record={detalle} onClose={() => setDetalle(null)} />
      )}
    </div>
  );
};
