import type { AuditEventRecord } from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AuditDiffDialog } from './AuditDiffDialog';
import { AuditTable } from './AuditTable';

/**
 * Pintado de la auditoría sin DOM: se renderiza a HTML estático y se comprueba
 * el texto que lee una persona —el diff antes/después, el motivo, el usuario y el
 * indicador de campos—, que es lo que la fase pide poder leer.
 *
 * Se usa `renderToStaticMarkup` (como el resto de pruebas de componentes del
 * proyecto): no hace falta `jsdom` ni `@testing-library`, que no están instalados.
 */
const EVENTO: AuditEventRecord = {
  id: '0f2f5f6a-1b1b-4a4c-8a5a-9f0a1b2c3d4e',
  occurredAt: '2026-10-01T14:03:00.000Z',
  actorId: null,
  actorUsername: 'recepcion',
  action: 'patient_updated',
  entityType: 'patient',
  entityId: 'aa11bb22-cc33-dd44-ee55-ff6677889900',
  summary: 'Teléfono del paciente actualizado',
  before: { phone: '+584121111111' },
  after: { phone: '+584142222222' },
  changedFields: ['phone'],
  reason: 'el paciente cambió de número',
  ip: '127.0.0.1',
  userAgent: 'Mozilla/5.0',
  requestId: 'req-1',
};

const dialogo = (evento: AuditEventRecord): string =>
  renderToStaticMarkup(
    createElement(AuditDiffDialog, {
      open: true,
      evento,
      onClose: () => undefined,
      onFiltrarEntidad: () => undefined,
    }),
  );

const tabla = (events: readonly AuditEventRecord[]): string =>
  renderToStaticMarkup(
    createElement(AuditTable, {
      events,
      onSelect: () => undefined,
      caption: '1–1 de 1',
    }),
  );

describe('detalle de un evento de auditoría', () => {
  it('muestra el valor anterior y el nuevo del campo, con el nombre en español', () => {
    const html = dialogo(EVENTO);

    expect(html).toContain('Paciente editado');
    expect(html).toContain('Teléfono');
    expect(html).toContain('+584121111111');
    expect(html).toContain('+584142222222');
  });

  it('enseña autor, motivo, IP, petición y la fecha en la hora del consultorio', () => {
    const html = dialogo(EVENTO);

    expect(html).toContain('recepcion');
    expect(html).toContain('el paciente cambió de número');
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('req-1');
    // 14:03 UTC son las 10:03 en Caracas: el día y la hora son los de la clínica.
    expect(html).toContain('01/10/2026');
    expect(html).toContain('10:03');
    expect(html).toContain('Ver todo de esta entidad');
  });

  it('avisa cuando el evento no guarda diff en vez de dejar la sección vacía', () => {
    const html = dialogo({
      ...EVENTO,
      action: 'login',
      entityType: 'session',
      before: null,
      after: null,
      changedFields: [],
      reason: null,
    });

    expect(html).toContain('Inicio de sesión');
    expect(html).toContain('no guarda valores anteriores y nuevos');
  });
});

describe('tabla de eventos', () => {
  it('lleva el usuario, el resumen, el motivo y el indicador de campos', () => {
    const html = tabla([EVENTO]);

    expect(html).toContain('recepcion');
    expect(html).toContain('Teléfono del paciente actualizado');
    expect(html).toContain('el paciente cambió de número');
    expect(html).toContain('1 campo');
    expect(html).toContain('Ver detalle');
  });

  it('un evento sin motivo ni campos no deja celdas vacías', () => {
    const html = tabla([
      {
        ...EVENTO,
        actorUsername: null,
        summary: null,
        reason: null,
        before: null,
        after: null,
        changedFields: ['phone', 'address'],
      },
    ]);

    expect(html).toContain('—');
    expect(html).toContain('2 campos');
  });
});
