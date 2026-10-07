import { describe, expect, it } from 'vitest';

import {
  ADMIN_ALERT_LEVELS,
  adminAlertSchema,
  formatAdminAlert,
  type AdminAlert,
} from './alerta-admin.js';

/**
 * El aviso al administrador es texto que se lee **en el móvil**, a cualquier hora y sin
 * contexto: lo que hay que fijar es que el mensaje diga las tres cosas que se necesitan para
 * decidir —qué pasa, qué tan grave es y de dónde viene— y que lo que llegue sin gravedad se
 * trate como aviso, no como un error crítico ni como una nota informativa.
 */

const aviso: AdminAlert = adminAlertSchema.parse({
  title: 'Evento perdido: clinical.session.closed',
  detail: 'Un evento de dominio agotó sus reintentos.',
  source: 'screens',
  context: { cola: 'domain-events.clinical', reintentos: 5 },
});

describe('el aviso al administrador', () => {
  it('sin gravedad explícita es un aviso, no un crítico', () => {
    expect(aviso.level).toBe('warning');
  });

  it('exige un título con cuerpo y un origen', () => {
    expect(() => adminAlertSchema.parse({ title: 'ab', source: 'screens' })).toThrow();
    expect(() => adminAlertSchema.parse({ title: 'Algo pasa', source: '' })).toThrow();
  });

  it('el contexto es opcional y vacío por defecto', () => {
    const minimo = adminAlertSchema.parse({ title: 'Algo pasa', source: 'estado' });
    expect(minimo.context).toEqual({});
    expect(minimo.detail).toBeNull();
  });

  it('las gravedades son las tres del catálogo', () => {
    expect(ADMIN_ALERT_LEVELS).toEqual(['critical', 'warning', 'info']);
  });

  it('el mensaje lleva la gravedad, el título, el detalle, el contexto, la hora y el origen', () => {
    const texto = formatAdminAlert(aviso, new Date('2026-10-07T13:05:00.000Z'));

    // El icono se comprueba por su punto de código y no escribiendo el emoji en la prueba:
    // así el resultado no depende de cómo se guarde este archivo.
    expect([...texto][0]?.codePointAt(0)).toBe(0x1f7e0); // el círculo naranja de «aviso»

    expect(texto).toContain('AVISO');
    expect(texto).toContain('Evento perdido: clinical.session.closed');
    expect(texto).toContain('Un evento de dominio agotó sus reintentos.');
    expect(texto).toContain('cola: domain-events.clinical');
    expect(texto).toContain('reintentos: 5');
    // La hora va en la zona del consultorio (09:05 en Caracas son las 13:05 UTC).
    expect(texto).toContain('07/10/2026');
    expect(texto).toContain('09:05');
    expect(texto).toContain('screens');
  });

  it('lo crítico se distingue de lo informativo', () => {
    const critico = formatAdminAlert({ ...aviso, level: 'critical' });
    const info = formatAdminAlert({ ...aviso, level: 'info', detail: null });

    expect(critico).toContain('CRÍTICO');
    expect(info).toContain('INFO');
    // Cada gravedad tiene su icono (rojo el crítico, azul lo informativo).
    expect([...critico][0]?.codePointAt(0)).toBe(0x1f534);
    expect([...info][0]?.codePointAt(0)).toBe(0x1f535);
    // Sin detalle no queda un hueco raro en el mensaje.
    expect(info).not.toContain('\n\n\n');
  });
});
