import { AUDIT_ACTIONS, PERMISSIONS } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { PERMISSION_LABELS, auditActionLabel } from './i18n';

/**
 * El diccionario tiene que estar al día con los contratos: las listas crecen por fase y un código sin
 * etiqueta se ve en pantalla tal cual (`patient_updated`).
 *
 * Los permisos los vigila el `typecheck` —`PERMISSION_LABELS` es `Record<Permission, string>`, así que
 * falta una etiqueta no compila—, pero las acciones de auditoría son `Record<string, string>`: la
 * única red para ellas es esta prueba.
 */
describe('el diccionario cubre los catálogos de los contratos', () => {
  it('toda acción de auditoría tiene su etiqueta, y no es el código', () => {
    for (const accion of AUDIT_ACTIONS) {
      const etiqueta = auditActionLabel(accion);
      expect(etiqueta, `${accion} se mostraría con el código crudo`).not.toBe(accion);
      expect(etiqueta.trim().length, `${accion} tiene la etiqueta vacía`).toBeGreaterThan(0);
    }
  });

  it('todo permiso tiene su etiqueta en español', () => {
    for (const permiso of PERMISSIONS) {
      const etiqueta = PERMISSION_LABELS[permiso];
      expect(etiqueta?.trim().length, `${permiso} sin etiqueta`).toBeGreaterThan(0);
      expect(etiqueta, `${permiso} se mostraría con el código del permiso`).not.toBe(permiso);
    }
  });

  it('los cinco permisos de facturación de la Fase 11 están etiquetados', () => {
    for (const permiso of [
      'billing:read',
      'billing:write',
      'billing:collect',
      'billing:rates',
      'billing:void',
    ] as const) {
      expect(PERMISSION_LABELS[permiso], `${permiso} sin etiqueta`).toBeTruthy();
    }
  });
});
