import {
  LICENSE_KIND_LABELS,
  type LicenseKind,
  type LicensingEstado,
  type LicensingOrigen,
  type PublicLicensingView,
} from '@odontocrm/contracts';
import type { AlertVariant } from '@odontocrm/ui';

import { formatDate } from './format';
import { t, type TranslationKey } from './i18n';

/**
 * Piezas puras del licenciamiento offline ([ADR 0075](../../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 * El servidor manda ya el estado y el mensaje en español, así que aquí no se
 * reescribe la regla (quiénes están vencidos o cuántos días quedan): solo se decide
 * **cómo se pinta** —el tono del aviso, su título y los rótulos del detalle—. Es lo
 * que se puede probar sin navegador y lo que evita que el banner y la página cuenten
 * cosas distintas.
 *
 * Los nombres de los tipos de licencia sí salen de los contratos (`LICENSE_KIND_LABELS`)
 * a propósito: son los mismos que usa el mensaje del servidor y no queremos que un
 * «Trimestral» de aquí y un «trimestral» de allí se separen.
 */

/** Claves de TanStack Query: una para el aviso público y otra para el detalle admin. */
export const licensingKeys = {
  root: ['licencia'] as const,
  /** `GET /licensing/public`: la comparten el banner del login y el del shell. */
  publico: ['licencia', 'publico'] as const,
  /** `GET /licensing/status`: la página `/licencia` del administrador. */
  estado: ['licencia', 'estado'] as const,
};

/**
 * Tono del aviso. Se limita a los tres que usa el banner; el tono de la página
 * (que además puede ser `success` cuando la licencia está vigente) sale de
 * `tonoEstado`.
 */
export type BannerTono = 'info' | 'warning' | 'danger';

export interface BannerLicencia {
  tono: BannerTono;
  /** Título corto, en mayúsculas como el resto de los banners del sistema. */
  titulo: string;
  /** Explicación: la compone el servidor (ya viene redactada y sin secretos). */
  detalle: string;
}

/** Rótulo del título de la página según el estado que publica el servidor. */
const TITULO_ESTADO: Readonly<Record<LicensingEstado, TranslationKey>> = {
  trial: 'licencia.estado.trial',
  trial_por_vencer: 'licencia.estado.trialPorVencer',
  trial_vencida: 'licencia.estado.trialVencida',
  licencia_vigente: 'licencia.estado.vigente',
  licencia_por_vencer: 'licencia.estado.porVencer',
  licencia_vencida: 'licencia.estado.vencida',
  reloj_atrasado: 'licencia.estado.reloj',
};

/**
 * Tono de la página. A diferencia del banner, aquí `licencia_vigente` sí se pinta
 * (en verde) porque la página existe justamente para consultar el estado; el banner,
 * en cambio, no ocupa espacio cuando no hay nada que avisar.
 */
const TONO_ESTADO: Readonly<Record<LicensingEstado, AlertVariant>> = {
  trial: 'info',
  trial_por_vencer: 'warning',
  trial_vencida: 'danger',
  licencia_vigente: 'success',
  licencia_por_vencer: 'warning',
  licencia_vencida: 'danger',
  reloj_atrasado: 'danger',
};

/** «1 día» / «23 días», sin el clásico «1 días». */
export const diasTexto = (dias: number): string =>
  dias === 1 ? t('licencia.unDia') : t('licencia.dias', { dias });

/** Título del estado para la alerta de `/licencia`. */
export const tituloEstado = (estado: LicensingEstado): string => t(TITULO_ESTADO[estado]);

/** Variante de la alerta de `/licencia`: verde si está vigente, roja si es modo consulta. */
export const tonoEstado = (estado: LicensingEstado): AlertVariant => TONO_ESTADO[estado];

/** Origen del permiso de uso: la prueba que regala la instalación o una licencia. */
export const origenTexto = (origen: LicensingOrigen | null): string => {
  if (origen === 'trial') return t('licencia.origen.trial');
  if (origen === 'licencia') return t('licencia.origen.licencia');
  return t('comun.sinDato');
};

/** Nombre del tipo contratado; `null` mientras la instalación está en prueba. */
export const tipoTexto = (tipo: LicenseKind | null): string =>
  tipo === null ? t('comun.sinDato') : LICENSE_KIND_LABELS[tipo];

/**
 * Vencimiento del trial o de la licencia, `dd/mm/aaaa` en hora de Venezuela. Una
 * licencia **vitalicia** no vence ([ADR 0076](../../../docs/adr/0076-licencias-vitalicias.md)).
 */
export const vencimientoTexto = (vista: PublicLicensingView): string =>
  vista.venceEn === null ? t('licencia.detalle.sinVencimiento') : formatDate(vista.venceEn);

/** ¿Hay que enseñar el aviso de modo consulta? (el servidor ya lo dice, no se recalcula) */
export const enModoConsulta = (vista: PublicLicensingView | undefined): boolean =>
  vista?.soloLectura === true;

/**
 * Decide el banner a pintar, o `null` si no hay nada que avisar.
 *
 * - **Prueba**: informativo (aún no es un problema, pero conviene saber cuánto queda).
 * - **Por vencer** (prueba o licencia): aviso amarillo.
 * - **Vencida o reloj atrasado**: rojo, modo consulta.
 * - **Licencia vigente**: nada; el banner no ocupa ni un píxel (como el de MODO TEST
 *   cuando está apagado).
 */
export const bannerDeLicencia = (vista: PublicLicensingView | undefined): BannerLicencia | null => {
  if (vista === undefined) return null;

  const dias = diasTexto(vista.diasRestantes ?? 0);

  switch (vista.estado) {
    case 'trial':
      return { tono: 'info', titulo: t('licencia.banner.trial', { dias }), detalle: vista.mensaje };
    case 'trial_por_vencer':
      return {
        tono: 'warning',
        titulo: t('licencia.banner.trialPorVencer', { dias }),
        detalle: vista.mensaje,
      };
    case 'trial_vencida':
      return { tono: 'danger', titulo: t('licencia.banner.trialVencida'), detalle: vista.mensaje };
    case 'licencia_por_vencer':
      return {
        tono: 'warning',
        titulo: t('licencia.banner.porVencer', { dias }),
        detalle: vista.mensaje,
      };
    case 'licencia_vencida':
      return { tono: 'danger', titulo: t('licencia.banner.vencida'), detalle: vista.mensaje };
    case 'reloj_atrasado':
      return { tono: 'danger', titulo: t('licencia.banner.reloj'), detalle: vista.mensaje };
    case 'licencia_vigente':
      return null;
  }
};
