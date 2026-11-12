import type { PublicLicensingView } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  bannerDeLicencia,
  diasTexto,
  enModoConsulta,
  licensingKeys,
  origenTexto,
  tipoTexto,
  tituloEstado,
  tonoEstado,
  vencimientoTexto,
} from './licensing';

/**
 * Piezas puras del licenciamiento: lo que decide **cómo se pinta** el estado. La
 * regla de negocio (quién está vencido y cuántos días quedan) la decide el servidor
 * con `resolveLicensing`; aquí solo se comprueba que el banner y la página no se
 * confundan de tono ni de texto.
 */
const vista = (over: Partial<PublicLicensingView> = {}): PublicLicensingView => ({
  estado: 'trial',
  soloLectura: false,
  origen: 'trial',
  tipo: null,
  diasRestantes: 23,
  venceEn: '2026-12-11T12:00:00.000-04:00',
  mensaje: 'Estás en el periodo de prueba: quedan 23 días.',
  ...over,
});

describe('diasTexto', () => {
  it('singular y plural en español', () => {
    expect(diasTexto(1)).toBe('1 día');
    expect(diasTexto(0)).toBe('0 días');
    expect(diasTexto(23)).toBe('23 días');
  });
});

describe('bannerDeLicencia', () => {
  it('no pinta nada mientras no se sabe el estado', () => {
    expect(bannerDeLicencia(undefined)).toBeNull();
  });

  it('no pinta nada con la licencia vigente: no hay nada que avisar', () => {
    expect(
      bannerDeLicencia(
        vista({
          estado: 'licencia_vigente',
          origen: 'licencia',
          tipo: 'anual',
          diasRestantes: 200,
        }),
      ),
    ).toBeNull();
  });

  it('la prueba se avisa en tono informativo y con los días que quedan', () => {
    const aviso = bannerDeLicencia(vista());
    expect(aviso?.tono).toBe('info');
    expect(aviso?.titulo).toContain('PRUEBA');
    expect(aviso?.titulo).toContain('23 días');
    // El detalle es el mensaje del servidor, no una segunda redacción.
    expect(aviso?.detalle).toBe(vista().mensaje);
    expect(aviso?.titulo).not.toContain('{');
  });

  it('la prueba por vencer pasa a aviso amarillo', () => {
    const aviso = bannerDeLicencia(vista({ estado: 'trial_por_vencer', diasRestantes: 3 }));
    expect(aviso?.tono).toBe('warning');
    expect(aviso?.titulo).toContain('3 días');
  });

  it('la prueba vencida y la licencia vencida son modo consulta (rojo)', () => {
    const trial = bannerDeLicencia(
      vista({ estado: 'trial_vencida', soloLectura: true, diasRestantes: 0 }),
    );
    expect(trial?.tono).toBe('danger');
    expect(trial?.titulo).toContain('modo consulta');

    const licencia = bannerDeLicencia(
      vista({
        estado: 'licencia_vencida',
        soloLectura: true,
        origen: 'licencia',
        tipo: 'mensual',
        diasRestantes: 0,
      }),
    );
    expect(licencia?.tono).toBe('danger');
    expect(licencia?.titulo).toContain('modo consulta');
  });

  it('la licencia por vencer avisa sin ser un error', () => {
    const aviso = bannerDeLicencia(
      vista({
        estado: 'licencia_por_vencer',
        origen: 'licencia',
        tipo: 'trimestral',
        diasRestantes: 6,
      }),
    );
    expect(aviso?.tono).toBe('warning');
    expect(aviso?.titulo).toContain('LICENCIA');
  });

  it('el reloj atrasado se trata como modo consulta', () => {
    const aviso = bannerDeLicencia(vista({ estado: 'reloj_atrasado', soloLectura: true }));
    expect(aviso?.tono).toBe('danger');
    expect(aviso?.titulo).toContain('RELOJ');
  });
});

describe('rótulos de la página', () => {
  it('cada estado tiene título y tono (la página nunca queda sin alerta)', () => {
    const estados = [
      'trial',
      'trial_por_vencer',
      'trial_vencida',
      'licencia_vigente',
      'licencia_por_vencer',
      'licencia_vencida',
      'reloj_atrasado',
    ] as const;

    for (const estado of estados) {
      const titulo = tituloEstado(estado);
      expect(titulo.length).toBeGreaterThan(0);
      expect(titulo).not.toBe(estado);
      expect(tonoEstado(estado)).toMatch(/^(info|success|warning|danger)$/);
    }

    expect(tonoEstado('licencia_vigente')).toBe('success');
    expect(tonoEstado('licencia_vencida')).toBe('danger');
  });

  it('el origen se escribe en español y el tipo usa el catálogo del contrato', () => {
    expect(origenTexto('trial')).toBe('Prueba');
    expect(origenTexto('licencia')).toBe('Licencia');
    expect(origenTexto(null)).toBe('—');
    expect(tipoTexto('mensual')).toBe('Mensual');
    expect(tipoTexto('trimestral')).toBe('Trimestral');
    expect(tipoTexto('anual')).toBe('Anual');
    expect(tipoTexto(null)).toBe('—');
  });

  it('el vencimiento se pinta en hora de Venezuela (dd/mm/aaaa)', () => {
    expect(vencimientoTexto(vista())).toBe('11/12/2026');
  });

  it('una vitalicia se pinta sin vencimiento y sin banner', () => {
    const vitalicia = vista({
      estado: 'licencia_vigente',
      origen: 'licencia',
      tipo: 'vitalicia',
      diasRestantes: null,
      venceEn: null,
      mensaje: 'Licencia vitalicia: no vence y no hay que renovarla.',
    });

    expect(tipoTexto('vitalicia')).toBe('Vitalicia');
    expect(vencimientoTexto(vitalicia)).toBe('Sin vencimiento (vitalicia)');
    expect(bannerDeLicencia(vitalicia)).toBeNull();
    expect(enModoConsulta(vitalicia)).toBe(false);
  });

  it('modo consulta es exactamente lo que dice el servidor', () => {
    expect(enModoConsulta(undefined)).toBe(false);
    expect(enModoConsulta(vista())).toBe(false);
    expect(enModoConsulta(vista({ estado: 'licencia_vencida', soloLectura: true }))).toBe(true);
  });
});

describe('claves de consulta', () => {
  it('el detalle y el aviso público no comparten caché', () => {
    expect(licensingKeys.publico).not.toEqual(licensingKeys.estado);
    expect(licensingKeys.estado[0]).toBe('licencia');
  });
});
