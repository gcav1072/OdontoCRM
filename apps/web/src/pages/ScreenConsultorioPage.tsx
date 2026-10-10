import type { ConsultationChair } from '@odontocrm/contracts';
import { Badge, cn } from '@odontocrm/ui';
import { Clock, Maximize, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { CriticalFlagsCard } from '../components/screens/CriticalFlagsCard';
import { KioskNotice } from '../components/screens/KioskNotice';
import { KioskStatusBar } from '../components/screens/KioskStatusBar';
import { useKioskState } from '../components/screens/useKioskState';
import { useScreenTexts } from '../hooks/useScreenTexts';
import { formatTime } from '../lib/format';
import { t } from '../lib/i18n';

/**
 * `/pantalla/consultorio` (Fase 5): la pantalla que está **dentro** del
 * consultorio, mirando al doctor.
 *
 * A diferencia del displaylobby, aquí no se llama a nadie: se informa de quién
 * está siendo atendido (nombre abreviado, edad, ticket, motivo) y, sobre todo,
 * se resaltan los **datos críticos** del paciente con un semáforo de riesgo:
 * rojo para lo que mata, ámbar para lo que hay que tener presente.
 *
 * Tampoco hay voz: el TTS es del llamado de la sala, no de esta pantalla.
 */
export const ScreenConsultorioPage = () => {
  const { estado, sinToken, dispositivo, conectada, sinPermiso, reintentar } =
    useKioskState('consultorio');
  const [esPantallaCompleta, setEsPantallaCompleta] = useState(false);
  const tr = useScreenTexts();

  const sillas = estado?.chairs ?? [];
  const waitingCount = estado?.waitingCount ?? 0;

  // El botón refleja el estado real del navegador (también al salir con Escape).
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
    // Puede fallar según el navegador o los permisos del quiosco: no es crítico.
    void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  return (
    <div className="min-h-dvh overflow-x-hidden bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-8 py-5">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-white">
            <Stethoscope className="size-7 text-sky-300" aria-hidden="true" />
            {tr('pantalla.consultorio.titulo')}
          </h1>
          {dispositivo !== null && <p className="truncate text-sm text-slate-400">{dispositivo}</p>}
        </div>

        <p className="text-2xl font-semibold text-sky-300">
          {tr('pantalla.sala.count', { total: waitingCount })}
        </p>

        {/* Una pantalla sin token no está «desconectada»: está sin configurar. */}
        {!sinToken && (
          <KioskStatusBar conectada={conectada} actualizado={estado?.updatedAt ?? null} />
        )}

        <button
          type="button"
          onClick={alternarPantallaCompleta}
          /* Sin clave propia para el botón de pantalla completa: se etiqueta con
             el nombre del dispositivo (o con el de la pantalla), que es lo que
             identifica a este televisor (ver informe). */
          aria-label={dispositivo ?? tr('pantalla.consultorio.titulo')}
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
        ) : sillas.length === 0 ? (
          <KioskNotice titulo={t('pantalla.consultorio.vacio')} />
        ) : (
          /* Una TV compartida: un tile por consultorio (con paciente o libre). */
          <div
            className={cn(
              'grid gap-6',
              sillas.length === 1 ? 'grid-cols-1' : 'sm:grid-cols-2 xl:grid-cols-3',
            )}
          >
            {sillas.map((silla) => (
              <ChairTile key={silla.chairId ?? silla.chairLabel} silla={silla} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

/** Un consultorio en la pantalla compartida: ocupado (con sus datos) o libre. */
const ChairTile = ({ silla }: { silla: ConsultationChair }) => {
  const tr = useScreenTexts();
  const ocupado = silla.appointmentId !== null;
  /** Con paciente pero sin `since`: está llamado y entrando al consultorio. */
  const entrando = ocupado && silla.since === null;

  return (
    <section
      className={cn(
        'rounded-card border-2 px-6 py-5',
        silla.estado === 'en_consulta'
          ? 'border-sky-500 bg-slate-900/80'
          : ocupado
            ? 'border-slate-600 bg-slate-900/60'
            : 'border-slate-800 bg-slate-900/30',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold tracking-tight text-sky-300">{silla.chairLabel}</h2>
        {silla.estado === 'en_consulta' ? (
          <Badge variant="success" className="text-sm">
            {tr('pantalla.consultorio.enConsulta')}
          </Badge>
        ) : silla.estado === 'llamado' ? (
          <Badge variant="warning" className="text-sm">
            {tr('pantalla.consultorio.llamado')}
          </Badge>
        ) : (
          <Badge variant="neutral" className="text-sm">
            {tr('pantalla.consultorio.libre')}
          </Badge>
        )}
      </div>

      {!ocupado ? (
        <p className="pt-3 text-2xl text-slate-500">{tr('pantalla.consultorio.libre')}</p>
      ) : (
        <>
          <p className="pt-3 text-5xl font-bold tracking-tight text-white">
            {silla.patientDisplayName}
          </p>

          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 pt-3">
            {silla.age !== null && (
              <span className="text-2xl font-semibold text-slate-200">
                {t('pantalla.consultorio.edad', { edad: silla.age })}
              </span>
            )}
            {silla.sex !== null && (
              <span className="text-2xl font-semibold text-slate-200">
                {t('pantalla.consultorio.sexo', { sexo: silla.sex })}
              </span>
            )}
            {silla.ticket !== null && (
              <span className="text-2xl font-semibold text-sky-300">
                {t('pantalla.consultorio.ticket', { ticket: silla.ticket })}
              </span>
            )}
            {entrando && (
              <Badge variant="warning" className="text-base">
                {t('pantalla.consultorio.entrando')}
              </Badge>
            )}
          </div>

          {silla.since !== null && (
            <p className="flex items-center gap-2 pt-2 text-base text-slate-300">
              <Clock className="size-4" aria-hidden="true" />
              {t('pantalla.consultorio.espera', { hora: formatTime(silla.since) })}
            </p>
          )}

          <div className="pt-4">
            <h3 className="text-base font-semibold text-slate-300">
              {t('pantalla.consultorio.motivo')}
            </h3>
            <p className={cn('pt-1 text-xl text-white', silla.reason === null && 'text-slate-400')}>
              {silla.reason ?? t('comun.sinDato')}
            </p>
          </div>

          <div className="pt-4">
            <CriticalFlagsCard flags={silla.criticalFlags} />
          </div>
        </>
      )}
    </section>
  );
};
