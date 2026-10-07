import { describe, expect, it } from 'vitest';

import { dominioDe, invalidacionesDe } from './realtime';
import { schedulingKeys } from './scheduling';

/**
 * El canal del personal no manda datos: manda el **tema** de lo que cambió y la interfaz
 * decide qué volver a pedir. Esta traducción es la parte que hay que fijar: si se
 * equivoca, la pantalla se queda con datos viejos sin que nadie se entere (o recarga de
 * más y el consultorio trabaja con la interfaz parpadeando).
 *
 * Los temas van escritos **como viajan por el cable** —`clinical.session.closed`— y no
 * importados del catálogo de eventos: aquí lo que se prueba es el contrato de la API, y
 * la interfaz los recibe como texto.
 */

const contiene = (claves: readonly (readonly unknown[])[], buscada: readonly unknown[]): boolean =>
  claves.some((clave) => JSON.stringify(clave) === JSON.stringify(buscada));

describe('la traducción de un aviso a consultas por refrescar', () => {
  it('el dominio es el primer segmento del tema', () => {
    expect(dominioDe('clinical.session.closed')).toBe('clinical');
    expect(dominioDe('billing.invoice.issued')).toBe('billing');
    expect(dominioDe('stream.ready')).toBe('stream');
    expect(dominioDe('raro')).toBe('raro');
  });

  it('cerrar una sesión deja viejas la historia, la agenda y la caja', () => {
    const claves = invalidacionesDe('clinical.session.closed');
    // La historia del paciente (lo que acaba de cerrarse).
    expect(contiene(claves, ['clinica'])).toBe(true);
    // La fila de la cola de recepción: es el caso que motivó la mejora.
    expect(contiene(claves, schedulingKeys.daysRoot)).toBe(true);
    expect(contiene(claves, schedulingKeys.historyRoot)).toBe(true);
    // Y el borrador por cobrar que nace en la caja.
    expect(contiene(claves, ['billing'])).toBe(true);
  });

  it('emitir una factura solo toca la caja', () => {
    expect(invalidacionesDe('billing.invoice.issued')).toEqual([['billing']]);
  });

  it('un paso de la cita refresca la agenda, no la caja', () => {
    const claves = invalidacionesDe('scheduling.appointment.called');
    expect(contiene(claves, schedulingKeys.daysRoot)).toBe(true);
    expect(contiene(claves, ['billing'])).toBe(false);
  });

  it('un hallazgo del odontograma refresca el odontograma y la historia', () => {
    const claves = invalidacionesDe('odontogram.finding.recorded');
    expect(contiene(claves, ['odontograma'])).toBe(true);
    expect(contiene(claves, ['clinica'])).toBe(true);
  });

  it('un tema de un dominio desconocido no recarga nada', () => {
    expect(invalidacionesDe('inventado.evento.raro')).toEqual([]);
    // Ni siquiera el aviso de que el canal está vivo.
    expect(invalidacionesDe('stream.ready')).toEqual([]);
  });

  it('el aviso de un dominio conocido funciona aunque el evento sea nuevo', () => {
    // El mapa va por dominio a propósito: un evento nuevo de clínica no exige tocar
    // la interfaz para que las pantallas se enteren.
    expect(invalidacionesDe('clinical.vaya.el.nombre.que.sea')).toEqual(
      invalidacionesDe('clinical.session.closed'),
    );
  });
});
