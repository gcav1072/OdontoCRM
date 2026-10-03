import { Badge, cn } from '@odontocrm/ui';
import { Clock, Maximize, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { CriticalFlagsCard } from '../components/screens/CriticalFlagsCard';
import { KioskNotice } from '../components/screens/KioskNotice';
import { KioskStatusBar } from '../components/screens/KioskStatusBar';
import { useKioskState } from '../components/screens/useKioskState';
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

  const paciente = estado;

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

  /** Con paciente pero sin `since`: está llamado y entrando al consultorio. */
  const entrando = paciente !== null && paciente.appointmentId !== null && paciente.since === null;

  return (
    <div className="min-h-dvh overflow-x-hidden bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-8 py-5">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-white">
            <Stethoscope className="size-7 text-sky-300" aria-hidden="true" />
            {t('pantalla.consultorio.titulo')}
          </h1>
          {dispositivo !== null && <p className="truncate text-sm text-slate-400">{dispositivo}</p>}
        </div>

        <p className="text-2xl font-semibold text-sky-300">
          {t('pantalla.sala.count', { total: paciente?.waitingCount ?? 0 })}
        </p>

        {/* Una pantalla sin token no está «desconectada»: está sin configurar. */}
        {!sinToken && (
          <KioskStatusBar conectada={conectada} actualizado={paciente?.updatedAt ?? null} />
        )}

        <button
          type="button"
          onClick={alternarPantallaCompleta}
          /* Sin clave propia para el botón de pantalla completa: se etiqueta con
             el nombre del dispositivo (o con el de la pantalla), que es lo que
             identifica a este televisor (ver informe). */
          aria-label={dispositivo ?? t('pantalla.consultorio.titulo')}
          aria-pressed={esPantallaCompleta}
          className="rounded-control border border-slate-700 p-2 text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-sky-400"
        >
          <Maximize className="size-5" aria-hidden="true" />
        </button>
      </header>

      <main className="space-y-6 px-8 py-6">
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
        ) : paciente === null || paciente.appointmentId === null ? (
          <KioskNotice titulo={t('pantalla.consultorio.vacio')} />
        ) : (
          <>
            <section className="rounded-card border-2 border-slate-700 bg-slate-900/70 px-8 py-6">
              <p className="text-7xl font-bold tracking-tight text-white">
                {paciente.patientDisplayName}
              </p>

              <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 pt-4">
                {paciente.age !== null && (
                  <span className="text-3xl font-semibold text-slate-200">
                    {t('pantalla.consultorio.edad', { edad: paciente.age })}
                  </span>
                )}
                {paciente.sex !== null && (
                  <span className="text-3xl font-semibold text-slate-200">
                    {t('pantalla.consultorio.sexo', { sexo: paciente.sex })}
                  </span>
                )}
                {paciente.ticket !== null && (
                  <span className="text-3xl font-semibold text-sky-300">
                    {t('pantalla.consultorio.ticket', { ticket: paciente.ticket })}
                  </span>
                )}
                {entrando && (
                  <Badge variant="warning" className="text-lg">
                    {t('pantalla.consultorio.entrando')}
                  </Badge>
                )}
              </div>

              {paciente.since !== null && (
                <p className="flex items-center gap-2 pt-3 text-lg text-slate-300">
                  <Clock className="size-5" aria-hidden="true" />
                  {t('pantalla.consultorio.espera', { hora: formatTime(paciente.since) })}
                </p>
              )}
            </section>

            <section className="rounded-card border border-slate-700 bg-slate-900/60 px-8 py-5">
              <h2 className="text-xl font-semibold text-slate-200">
                {t('pantalla.consultorio.motivo')}
              </h2>
              <p
                className={cn(
                  'pt-1 text-3xl text-white',
                  paciente.reason === null && 'text-slate-400',
                )}
              >
                {paciente.reason ?? t('comun.sinDato')}
              </p>
            </section>

            <CriticalFlagsCard flags={paciente.criticalFlags} />
          </>
        )}
      </main>
    </div>
  );
};
