import type { CallEvent } from '@odontocrm/contracts';
import { abbreviateName } from '@odontocrm/contracts';
import { Badge, cn } from '@odontocrm/ui';
import { Maximize } from 'lucide-react';
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
import { t } from '../lib/i18n';
import { llamadoVigente, turnoLabel } from '../lib/screens';

/**
 * `/pantalla/lobby` (Fase 5): el **displaylobby** de la sala de espera.
 *
 * Es un televisor, no una aplicación: fondo oscuro de alto contraste, tipografía
 * enorme, cero controles que se puedan pulsar por accidente (el único botón es
 * el de pantalla completa, discreto y esquinado) y sin desplazamiento horizontal.
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
}

const CalledRow = ({ call, destacado, vigente, compacto }: CalledRowProps) => (
  <li
    className={cn(
      'rounded-card border-2 bg-slate-900/70 px-6 py-4',
      vigente ? 'border-sky-400' : 'border-slate-700',
      destacado ? 'py-6' : null,
    )}
  >
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <span
        className={cn(
          'font-bold tracking-tight text-white',
          compacto ? 'text-3xl' : destacado ? 'text-7xl' : 'text-5xl',
        )}
      >
        {abbreviateName(call.patientDisplayName)}
      </span>
      {call.callNumber >= 2 && (
        <Badge variant="danger" className="text-sm">
          {t('pantalla.lobby.segundoLlamado')}
        </Badge>
      )}
    </div>

    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 pt-2">
      <span
        className={cn(
          'font-semibold text-sky-300',
          compacto ? 'text-xl' : destacado ? 'text-4xl' : 'text-3xl',
        )}
      >
        {t('pantalla.lobby.turno', { turno: turnoLabel(call) })}
      </span>
      <span
        className={cn(
          'font-semibold text-emerald-300',
          compacto ? 'text-xl' : destacado ? 'text-4xl' : 'text-3xl',
        )}
      >
        {t('pantalla.lobby.pasar', { sillon: call.chairLabel })}
      </span>
    </div>
  </li>
);

export const ScreenLobbyPage = () => {
  const { estado, sinToken, dispositivo, ajustes, conectada, sinPermiso, reintentar } =
    useKioskState('lobby');
  const [esPantallaCompleta, setEsPantallaCompleta] = useState(false);

  const lobby = estado;
  const llamados = lobby?.calls ?? [];
  const masNuevo = llamados[0] ?? null;

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
    [ajustes?.volumen],
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
    <div className="min-h-dvh overflow-x-hidden bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-8 py-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            {t('pantalla.lobby.titulo')}
          </h1>
          {dispositivo !== null && <p className="truncate text-sm text-slate-400">{dispositivo}</p>}
        </div>

        <p className="text-2xl font-semibold text-sky-300">
          {t('pantalla.sala.count', { total: lobby?.waitingCount ?? 0 })}
        </p>

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
          aria-label={dispositivo ?? t('pantalla.lobby.titulo')}
          aria-pressed={esPantallaCompleta}
          className="rounded-control border border-slate-700 p-2 text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-sky-400"
        >
          <Maximize className="size-5" aria-hidden="true" />
        </button>
      </header>

      <main className="px-8 py-6">
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
                destacado={indice === 0}
                vigente={indice === 0 && llamadoVigente(call, resalteSegundos)}
                compacto={false}
              />
            ))}
            {llamados.slice(MAX_LLAMADOS_GRANDES).map((call) => (
              <CalledRow key={call.id} call={call} destacado={false} vigente={false} compacto />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
};
