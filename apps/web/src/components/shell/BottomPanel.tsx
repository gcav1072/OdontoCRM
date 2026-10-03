import { Badge, Button, cn } from '@odontocrm/ui';
import { ChevronUp, House, LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatDuration, formatRelative, formatTime, formatUserAgent } from '../../lib/format';
import { ROLE_LABELS, t } from '../../lib/i18n';
import { useAuth } from '../../providers/AuthProvider';
import { ThemeSelector } from './ThemeSelector';

export interface BottomPanelProps {
  open: boolean;
  onToggle: () => void;
}

/**
 * Panel inferior ocultable (requisito explícito de la Fase 1).
 *
 * Es una banda fija abajo con dos partes: el cuerpo desplegable —cerrar sesión,
 * selector de tema, información del login y botón Inicio— y el tirador, que
 * siempre está visible. Se abre con un clic o con `Ctrl + J` (el atajo lo
 * registra `AppShell`), se cierra con Escape y el estado abierto/cerrado se
 * recuerda en `localStorage`.
 */
export const BottomPanel = ({ open, onToggle }: BottomPanelProps) => {
  const { user, roles, permissions, sessionInfo, logout, status } = useAuth();
  const navigate = useNavigate();
  const [saliendo, setSaliendo] = useState(false);
  const cuerpoId = useId();

  useEffect(() => {
    if (!open) return;
    const alPulsar = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle();
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [open, onToggle]);

  const cerrarSesion = async () => {
    setSaliendo(true);
    try {
      await logout();
    } finally {
      setSaliendo(false);
    }
  };

  const irAInicio = () => {
    void navigate('/inicio');
  };

  const nombreRoles = roles.map((rol) => ROLE_LABELS[rol]).join(' · ');

  return (
    <section
      aria-label={t('panel.titulo')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface shadow-panel"
    >
      <div
        id={cuerpoId}
        hidden={!open}
        className="max-h-[60vh] overflow-y-auto border-b border-border"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-5 sm:grid-cols-2 lg:grid-cols-4 lg:px-8">
          {/* Identidad y salida al inicio */}
          <div className="space-y-3">
            <h2 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              {t('sesion.activa')}
            </h2>
            <div className="space-y-1">
              <p className="truncate text-sm font-semibold text-ink">
                {user?.fullName ?? t('comun.sinDato')}
              </p>
              <p className="truncate font-mono text-xs text-ink-muted">
                {user?.username ?? t('comun.sinDato')}
              </p>
              {nombreRoles.length > 0 && (
                <p className="flex flex-wrap gap-1 pt-1">
                  {roles.map((rol) => (
                    <Badge key={rol} variant="primary">
                      {ROLE_LABELS[rol]}
                    </Badge>
                  ))}
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={irAInicio}
              leadingIcon={<House className="size-4" aria-hidden="true" />}
            >
              {t('modulo.inicio.titulo')}
            </Button>
          </div>

          {/* Información del login */}
          <div className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              {t('sesion.iniciada')}
            </h2>
            <dl className="space-y-1.5 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-muted">{t('sesion.iniciada')}:</dt>
                <dd className="font-medium text-ink">
                  {t('sesion.iniciadaA', { hora: formatTime(sessionInfo?.loginAt) })}
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-muted">{t('sesion.duracion')}:</dt>
                <dd className="text-ink">
                  {sessionInfo ? formatDuration(sessionInfo.loginAt) : t('comun.sinDato')}
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-muted">{t('comun.cerrarSesion')}:</dt>
                <dd className="text-ink">
                  {sessionInfo
                    ? `${t('sesion.caducaA', { hora: formatTime(sessionInfo.expiresAt) })} (${formatRelative(sessionInfo.expiresAt)})`
                    : t('comun.sinDato')}
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-muted">{t('sesion.ip')}:</dt>
                <dd className="font-mono text-xs text-ink">
                  {sessionInfo?.ip ?? t('comun.sinDato')}
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-muted">{t('sesion.equipo')}:</dt>
                <dd
                  className="truncate text-xs text-ink-subtle"
                  title={sessionInfo?.userAgent ?? ''}
                >
                  {formatUserAgent(sessionInfo?.userAgent)}
                </dd>
              </div>
            </dl>
          </div>

          {/* Tema */}
          <div className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              {t('tema.titulo')}
            </h2>
            <ThemeSelector />
            <p className="text-xs text-ink-subtle">{t('tema.descripcion')}</p>
          </div>

          {/* Permisos y cierre de sesión */}
          <div className="space-y-3">
            <h2 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              {t('sesion.permisos')}
            </h2>
            <p className="flex items-center gap-2 text-xs text-ink-muted">
              <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{t('sesion.permisosCuenta', { total: permissions.length })}</span>
            </p>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void cerrarSesion()}
              loading={saliendo}
              disabled={status !== 'autenticado'}
              leadingIcon={<LogOut className="size-4" aria-hidden="true" />}
            >
              {t('comun.cerrarSesion')}
            </Button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={cuerpoId}
        aria-label={open ? t('panel.cerrar') : t('panel.abrir')}
        className={cn(
          'flex h-11 w-full items-center justify-center gap-2 px-4 text-xs font-medium text-ink-muted transition-colors',
          'hover:bg-surface-muted hover:text-ink',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
        )}
      >
        <ChevronUp
          className={cn('size-4 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
        <span>{open ? t('panel.cerrar') : t('panel.abrir')}</span>
        <kbd className="hidden rounded-xs border border-border px-1.5 py-0.5 font-mono text-[0.65rem] text-ink-subtle sm:inline">
          {t('panel.atajo')}
        </kbd>
        {sessionInfo && !open && (
          <span className="truncate text-ink-subtle">
            · {t('sesion.caduca', { tiempo: formatRelative(sessionInfo.expiresAt) })}
          </span>
        )}
      </button>
    </section>
  );
};
