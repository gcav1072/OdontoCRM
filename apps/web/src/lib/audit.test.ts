import { describe, expect, it } from 'vitest';

import {
  actionLabel,
  auditKeys,
  changedFieldsLabel,
  emptyAuditFilters,
  entityTypeOptions,
  exportFileName,
  fieldLabel,
  hasActiveFilters,
  summaryLine,
  toQueryParams,
  type AuditFilterState,
} from './audit';

/**
 * Piezas puras del módulo de auditoría. La prueba corre en Node (sin DOM): lo que
 * se comprueba es la traducción de filtros a parámetros, las claves de caché, el
 * contador de resultados y los catálogos, no el pintado de la tabla.
 */
const conFiltros = (parcial: Partial<AuditFilterState>): AuditFilterState => ({
  ...emptyAuditFilters(),
  ...parcial,
});

describe('filtros de auditoría', () => {
  it('el estado vacío no manda ningún parámetro', () => {
    expect(toQueryParams(emptyAuditFilters())).toEqual({});
    expect(hasActiveFilters(emptyAuditFilters())).toBe(false);
  });

  it('omite los campos vacíos y recorta los textos', () => {
    const params = toQueryParams(
      conFiltros({ usuario: '  recepcion  ', accion: 'patient_updated', identificador: '' }),
    );

    expect(params).toEqual({ actorUsername: 'recepcion', action: 'patient_updated' });
    expect('entityId' in params).toBe(false);
    expect('from' in params).toBe(false);
  });

  it('las fechas del calendario viajan tal cual (`aaaa-mm-dd`)', () => {
    const params = toQueryParams(conFiltros({ desde: '2026-10-01', hasta: '2026-10-04' }));

    // El servidor las interpreta como el día completo en Venezuela.
    expect(params.from).toBe('2026-10-01');
    expect(params.to).toBe('2026-10-04');
  });

  it('un filtro con solo espacios no cuenta como filtro activo', () => {
    expect(hasActiveFilters(conFiltros({ campo: '   ' }))).toBe(false);
    expect(hasActiveFilters(conFiltros({ campo: 'phone' }))).toBe(true);
  });

  it('traduce cada filtro a su parámetro de la API', () => {
    expect(
      toQueryParams(
        conFiltros({
          desde: '2026-10-01',
          hasta: '2026-10-04',
          usuario: 'admin',
          accion: 'login',
          tipoEntidad: 'session',
          identificador: '11111111-1111-4111-8111-111111111111',
          campo: 'phone',
        }),
      ),
    ).toEqual({
      from: '2026-10-01',
      to: '2026-10-04',
      actorUsername: 'admin',
      action: 'login',
      entityType: 'session',
      entityId: '11111111-1111-4111-8111-111111111111',
      field: 'phone',
    });
  });

  it('la paginación no forma parte de los filtros (la exportación baja todo)', () => {
    const params = toQueryParams(conFiltros({ usuario: 'admin' }));

    expect('page' in params).toBe(false);
    expect('pageSize' in params).toBe(false);
  });
});

describe('claves de consulta', () => {
  it('es estable: los mismos filtros dan la misma clave', () => {
    const filtros = { ...toQueryParams(conFiltros({ usuario: 'admin' })), page: 2, pageSize: 50 };

    expect(auditKeys.events(filtros)).toEqual(auditKeys.events({ ...filtros }));
    expect(auditKeys.events(filtros)).toEqual(['auditoria', 'eventos', filtros]);
  });

  it('filtros distintos no comparten entrada de caché', () => {
    expect(auditKeys.events({ page: 1 })).not.toEqual(auditKeys.events({ page: 2 }));
  });

  it('la raíz sirve para invalidar el módulo entero', () => {
    expect(auditKeys.root).toEqual(['auditoria']);
  });
});

describe('contador de resultados', () => {
  it('sin resultados lo dice en vez de pintar un rango vacío', () => {
    expect(summaryLine({ page: 1, pageSize: 50, total: 0 })).toBe('Sin resultados');
  });

  it('con una sola página muestra el rango completo', () => {
    expect(summaryLine({ page: 1, pageSize: 50, total: 3 })).toBe('1–3 de 3');
  });

  it('con varias páginas numera desde el primer registro de la página', () => {
    expect(summaryLine({ page: 1, pageSize: 50, total: 320 })).toBe('1–50 de 320');
    expect(summaryLine({ page: 2, pageSize: 50, total: 320 })).toBe('51–100 de 320');
    expect(summaryLine({ page: 7, pageSize: 50, total: 320 })).toBe('301–320 de 320');
  });

  it('una página más allá del final se recorta al total', () => {
    expect(summaryLine({ page: 9, pageSize: 50, total: 320 })).toBe('320–320 de 320');
  });
});

describe('catálogos', () => {
  it('la acción conocida sale en español y la desconocida con su código', () => {
    expect(actionLabel('patient_updated')).toBe('Paciente editado');
    expect(actionLabel('accion_del_futuro')).toBe('accion_del_futuro');
  });

  it('los tipos de entidad que existen hoy tienen nombre en español', () => {
    const opciones = entityTypeOptions();
    const valores = opciones.map((opcion) => opcion.value);

    expect(valores).toEqual([
      'patient',
      'appointment',
      'request',
      'day_capacity',
      'slot_template',
      'user',
      'device_token',
      'medical_record',
      'clinical_session',
      'prescription',
      'tooth_finding',
      'odontogram',
      'refresh_token',
      'session',
      'dentist_profile',
      'clinic_profile',
    ]);
    expect(opciones.every((opcion) => opcion.label !== '' && opcion.label !== opcion.value)).toBe(
      true,
    );
    expect(opciones.find((opcion) => opcion.value === 'patient')?.label).toBe('Paciente');
  });

  it('el indicador de campos cambiados concuerda en número', () => {
    expect(changedFieldsLabel(1)).toBe('1 campo');
    expect(changedFieldsLabel(3)).toBe('3 campos');
  });

  it('los campos del paciente se nombran en español; los demás, tal cual', () => {
    expect(fieldLabel('phone', 'patient')).toBe('Teléfono');
    expect(fieldLabel('startTime', 'appointment')).toBe('startTime');
    expect(fieldLabel('campo_raro')).toBe('campo_raro');
  });
});

describe('nombre del archivo exportado', () => {
  it('refleja el rango consultado, como el del servidor', () => {
    expect(exportFileName({ from: '2026-10-01', to: '2026-10-04' })).toBe(
      'auditoria-2026-10-01_2026-10-04.csv',
    );
  });

  it('sin fechas usa inicio y fin', () => {
    expect(exportFileName({})).toBe('auditoria-inicio_fin.csv');
  });
});
