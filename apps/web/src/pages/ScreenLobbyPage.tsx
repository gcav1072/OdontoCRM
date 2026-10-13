import type { CallEvent } from '@odontocrm/contracts';
import { abbreviateName } from '@odontocrm/contracts';
import { cn } from '@odontocrm/ui';
import { Clock, Maximize } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { KioskNotice } from '../components/screens/KioskNotice';
import { KioskStatusBar } from '../components/screens/KioskStatusBar';
import {
  KIOSK_VOICE_DEFAULT,
  anunciarLlamado,
  callar,
  type KioskVoiceOptions,
} from '../components/screens/kiosk-speech';
import { useKioskState } from '../components/screens/useKioskState';
import { useKioskTheme } from '../components/screens/kiosk-theme';
import { useReloj } from '../hooks/useReloj';
import { useScreenTexts } from '../hooks/useScreenTexts';
import { formatTime } from '../lib/format';
import { t } from '../lib/i18n';
import { llamadoVigente, turnoLabel } from '../lib/screens';

/**
 * `/pantalla/lobby` (Fase 5): el **displaylobby** de la sala de espera.
 *
 * Es un televisor, no una aplicación: tipografía enorme, cero controles que se puedan
 * pulsar por accidente (el único botón es el de pantalla completa, discreto y esquinado)
 * y sin desplazamiento horizontal. La pantalla tiene su **propia** estética —modo
 * claro/oscuro, color de acento y marca de agua del logo— que se configura por pantalla en
 * `/pantallas` y **no** sigue a la de la aplicación (`useKioskTheme`).
 *
 * La cabecera, centrada, enseña el **nombre del consultorio** (el que se completó en el
 * primer login del titular) y, debajo, la **hora** y cuánta gente está **en sala**. Abajo,
 * en las esquinas, va lo discreto: a la izquierda «Sala de espera – ‹pantalla›» y a la
 * derecha el indicador de conexión con la última actualización.
 *
 * Se configura una sola vez abriendo `/pantalla/lobby?token=…`: el token se
 * guarda en el equipo y a partir de ahí la pantalla se reconecta sola. El estado
 * llega por SSE (`useKioskState`) y cada llamado nuevo se **lee en voz alta** con
 * la Web Speech API en español.
 *
 * La ventana de resalte y la voz salen de los ajustes del dispositivo, que la
 * pantalla pide al servicio de pantallas en cuanto tiene sesión (el login del
 * dispositivo no los trae: viven en `screens`, no en identity).
 */

/** Ventana de resalte cuando el dispositivo todavía no tiene ajustes. */
const RESALTE_SEGUNDOS_DEFECTO = 20;

/** A partir de este número de llamados, los últimos se pintan compactos. */
const MAX_LLAMADOS_GRANDES = 5;

interface CalledRowProps {
  call: CallEvent;
  /** El más reciente se pinta más grande: es al que hay que hacer caso. */
  destacado: boolean;
  /** Dentro de la ventana de resalte. */
  vigente: boolean;
  compacto: boolean;
  /** Posición en la lista, para escalonar la animación de entrada. */
  indice: number;
}

const CalledRow = ({ call, destacado, vigente, compacto, indice }: CalledRowProps) => {
  const tr = useScreenTexts();
  return (
    <li
      className={cn(
        'kiosk-entrada rounded-card border-2 bg-[var(--kiosk-surface)] px-6 py-4 shadow-[var(--kiosk-shadow)]',
        vigente ? 'kiosk-vigente border-[var(--kiosk-accent)]' : 'border-[var(--kiosk-border)]',
        destacado ? 'py-6' : null,
      )}
      /* Entrada escalonada: cada fila aparece un poco después que la anterior. */
      style={{ animationDelay: `${String(indice * 70)}ms` }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span
          className={cn(
            'font-bold tracking-tight text-[var(--kiosk-ink)]',
            compacto ? 'text-3xl' : destacado ? 'text-7xl' : 'text-5xl',
          )}
        >
          {abbreviateName(call.patientDisplayName)}
        </span>
        {call.callNumber >= 2 && (
          <span className="rounded-full border border-[var(--kiosk-danger)] bg-[var(--kiosk-danger-soft)] px-3 py-1 text-sm font-semibold text-[var(--kiosk-danger)]">
            {tr('pantalla.lobby.segundoLlamado')}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 pt-2">
        <span
          className={cn(
            'font-semibold text-[var(--kiosk-accent)]',
            compacto ? 'text-xl' : destacado ? 'text-4xl' : 'text-3xl',
          )}
        >
          {tr('pantalla.lobby.turno', { turno: turnoLabel(call) })}
        </span>
        <span
          className={cn(
            'font-semibold text-[var(--kiosk-ink)]',
            compacto ? 'text-xl' : destacado ? 'text-4xl' : 'text-3xl',
          )}
        >
          {tr('pantalla.lobby.pasar', { sillon: call.chairLabel })}
        </span>
      </div>
    </li>
  );
};

export const ScreenLobbyPage = () => {
  const { estado, sinToken, dispositivo, ajustes, clinic, conectada, sinPermiso, reintentar } =
    useKioskState('lobby');
  const [esPantallaCompleta, setEsPantallaCompleta] = useState(false);
  const tr = useScreenTexts();
  const { tema, vars } = useKioskTheme(ajustes);
  const ahora = useReloj();

  const lobby = estado;
  const llamados = lobby?.calls ?? [];
  const masNuevo = llamados[0] ?? null;
  /** La marca de agua solo se pinta si está pedida **y** hay logo que poner. */
  const marcaAgua = ajustes?.logoMarcaAgua === true && clinic?.logoDataUri != null;

  /**
   * Ajustes del televisor, los que configuró la administración en `/pantallas`:
   * si la voz está apagada no se lee nada, el volumen sale de ahí y la ventana de
   * resalte también. Mientras llegan se usan los valores por defecto.
   */
  const voz: KioskVoiceOptions = useMemo(
    () => ({
      ...KIOSK_VOICE_DEFAULT,
      ...(ajustes === null ? {} : { volumen: ajustes.volumen }),
    }),
    [ajustes],
  );
  const resalteSegundos = ajustes?.resalteSegundos ?? RESALTE_SEGUNDOS_DEFECTO;
  const vozActiva = ajustes?.voz !== false;

  /**
   * TTS: se lee **una sola vez** por llamado. El id del último anunciado vive en
   * un `ref` (no en estado) para no volver a disparar el efecto al leerlo.
   */
  const anunciadoRef = useRef<string | null>(null);
  useEffect(() => {
    if (masNuevo === null || anunciadoRef.current === masNuevo.id) return;
    anunciadoRef.current = masNuevo.id;
    if (vozActiva) anunciarLlamado(masNuevo, voz);
  }, [masNuevo, vozActiva, voz]);

  // Al desmontar (o al recargar la pantalla) se corta la voz: nadie quiere un
  // llamado a medias repitiéndose sobre la pantalla siguiente.
  useEffect(() => callar, []);

  // El botón de pantalla completa refleja el estado real del navegador,
  // incluido cuando se sale con Escape.
  useEffect(() => {
    const alCambiar = (): void => setEsPantallaCompleta(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', alCambiar);
    return () => document.removeEventListener('fullscreenchange', alCambiar);
  }, []);

  const alternarPantallaCompleta = useCallback((): void => {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    // Puede fallar (permisos del navegador en modo quiosco): no es crítico.
    void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  return (
    <div
      data-tema={tema}
      style={vars}
      className="kiosk-root flex min-h-dvh flex-col overflow-x-hidden"
    >
      {/* Marca de agua del logo del consultorio (silueta con alfa según el modo). */}
      {marcaAgua && clinic?.logoDataUri != null && (
        <div className="kiosk-watermark" aria-hidden="true">
          <img src={clinic.logoDataUri} alt="" />
        </div>
      )}

      {/* Cabecera centrada: nombre del consultorio y, debajo, hora y gente en sala. */}
      <header className="kiosk-aparece flex flex-col items-center gap-3 px-8 pt-10 pb-4 text-center">
        <h1 className="max-w-5xl text-balance text-4xl font-bold tracking-tight whitespace-pre-line text-[var(--kiosk-ink)] sm:text-5xl">
          {clinic?.name ?? tr('pantalla.lobby.titulo')}
        </h1>
        <span className="kiosk-filete h-1 w-40 rounded-full" aria-hidden="true" />
        <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1 text-2xl font-semibold">
          <span className="inline-flex items-center gap-2 tabular-nums text-[var(--kiosk-ink)]">
            <Clock className="size-6 text-[var(--kiosk-accent)]" aria-hidden="true" />
            <time dateTime={ahora.toISOString()}>{formatTime(ahora)}</time>
          </span>
          <span className="text-[var(--kiosk-ink-subtle)]" aria-hidden="true">
            ·
          </span>
          <span className="text-[var(--kiosk-accent)]">
            {tr('pantalla.sala.count', { total: lobby?.waitingCount ?? 0 })}
          </span>
        </p>
      </header>

      <main className="flex-1 px-8 pt-2 pb-24">
        {sinToken ? (
          /* Sin token no hay nada que mostrar ni que reintentar: el enlace se
             abre una vez desde el módulo Pantallas. */
          <KioskNotice
            titulo={t('pantalla.sinToken.titulo')}
            texto={t('pantalla.sinToken.texto')}
          />
        ) : sinPermiso ? (
          <KioskNotice
            titulo={t('pantalla.sinPermiso.titulo')}
            texto={t('pantalla.sinPermiso.texto')}
            onReintentar={reintentar}
          />
        ) : lobby === null ? (
          <KioskNotice titulo={t('pantalla.cargando')} />
        ) : llamados.length === 0 ? (
          <KioskNotice titulo={t('pantalla.lobby.vacio')} />
        ) : (
          <ul className="flex flex-col gap-4">
            {llamados.slice(0, MAX_LLAMADOS_GRANDES).map((call, indice) => (
              <CalledRow
                key={call.id}
                call={call}
                indice={indice}
                destacado={indice === 0}
                vigente={indice === 0 && llamadoVigente(call, resalteSegundos)}
                compacto={false}
              />
            ))}
            {llamados.slice(MAX_LLAMADOS_GRANDES).map((call, index) => (
              <CalledRow
                key={call.id}
                call={call}
                indice={MAX_LLAMADOS_GRANDES + index}
                destacado={false}
                vigente={false}
                compacto
              />
            ))}
          </ul>
        )}
      </main>

      {/*
        Pie discreto: a la izquierda, qué es esta pantalla (título + nombre del equipo);
        a la derecha, cómo va la conexión con la última actualización y el botón de pantalla
        completa. Todo pequeño y pegado a las esquinas, lejos de la mirada del paciente.
      */}
      <footer className="pointer-events-none fixed inset-x-0 bottom-0 flex items-end justify-between gap-4 px-8 py-5 text-sm">
        <p className="pointer-events-auto min-w-0 truncate text-[var(--kiosk-ink-subtle)]">
          {tr('pantalla.lobby.titulo')}
          {dispositivo !== null && (
            <>
              {' — '}
              <span className="text-[var(--kiosk-ink-muted)]">{dispositivo}</span>
            </>
          )}
        </p>

        <div className="pointer-events-auto flex items-center gap-4">
          {/* Una pantalla sin token no está «desconectada»: está sin configurar. */}
          {!sinToken && (
            <KioskStatusBar conectada={conectada} actualizado={lobby?.updatedAt ?? null} />
          )}

          <button
            type="button"
            onClick={alternarPantallaCompleta}
            /* Sin clave propia para el botón de pantalla completa: se etiqueta con
               el nombre del dispositivo (o con el de la pantalla), que es lo que
               identifica a este televisor (ver informe). */
            aria-label={dispositivo ?? tr('pantalla.lobby.titulo')}
            aria-pressed={esPantallaCompleta}
            className="rounded-control border border-[var(--kiosk-border)] p-2 text-[var(--kiosk-ink-subtle)] transition-colors hover:bg-[var(--kiosk-accent-soft)] hover:text-[var(--kiosk-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kiosk-focus)]"
          >
            <Maximize className="size-4" aria-hidden="true" />
          </button>
        </div>
      </footer>
    </div>
  );
};
