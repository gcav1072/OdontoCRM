import { CLINICAL_PROFILE_GROUPS, reportFiltersSchema } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { componerPerfilClinico, type FilaPerfil } from './clinical-profile.js';
import type { ReportContext } from './shared.js';

const contexto = (filtros: Record<string, unknown> = {}): ReportContext => ({
  filters: reportFiltersSchema.parse(filtros),
  range: { from: '2026-10-01', to: '2026-10-31' },
  generatedAt: '2026-10-31T12:00:00.000Z',
});

const paciente = (
  alerts: readonly string[],
  recordStatus: string | null = 'firmada',
): FilaPerfil => ({
  patientId: globalThis.crypto.randomUUID(),
  alerts,
  recordStatus,
});

describe('perfil clínico agregado', () => {
  it('cuenta por grupo con la definición del contrato (una alerta puede caer en varios)', () => {
    const documento = componerPerfilClinico(
      [
        paciente(['diabetes', 'hipertension']),
        paciente(['alergia_penicilina']),
        paciente(['diabetes', 'anticoagulante']),
        paciente([]),
      ],
      contexto(),
    );

    const porGrupo = new Map(
      documento.table.rows.map((fila) => [fila['grupo'], fila['pacientes']]),
    );
    expect(porGrupo.get('Diabetes')).toBe(2);
    expect(porGrupo.get('Hipertensión')).toBe(1);
    expect(porGrupo.get('Alergias')).toBe(1);
    expect(porGrupo.get('Anticoagulados')).toBe(1);
    expect(porGrupo.get('Cardiopatía')).toBe(0);
    expect(documento.table.rows).toHaveLength(CLINICAL_PROFILE_GROUPS.length);
    // El porcentaje es sobre el total de pacientes y no suma 100: un paciente puede
    // estar en varios grupos.
    expect(porGrupo.get('Diabetes')).toBe(2);
    expect(documento.kpis.find((kpi) => kpi.label === 'Pacientes atendidos')?.value).toBe(4);
    expect(documento.kpis.find((kpi) => kpi.label === 'Con antecedentes')?.value).toBe(3);
  });

  it('todos los grupos de alergia cuentan como alergias', () => {
    const documento = componerPerfilClinico(
      [
        paciente(['alergia_penicilina']),
        paciente(['alergia_anestesico']),
        paciente(['alergia_latex']),
        paciente(['alergia_otro']),
      ],
      contexto(),
    );
    const fila = documento.table.rows.find((fila) => fila['grupo'] === 'Alergias');
    expect(fila?.['pacientes']).toBe(4);
    expect(fila?.['porcentaje']).toBe(100);
  });

  it('avisa de los pacientes sin historia clínica y de los filtros', () => {
    const documento = componerPerfilClinico(
      [paciente(['diabetes']), paciente([], null)],
      contexto({ sex: 'F', status: 'activo' }),
    );
    const notas = documento.notes.join(' ');
    expect(notas).toContain('no tienen historia clínica abierta');
    expect(notas).toContain('Filtros aplicados: sexo F, estado activo');
    expect(notas).toContain('varios grupos');
  });

  it('sin pacientes avisa y el grupo mayor queda vacío', () => {
    const documento = componerPerfilClinico([], contexto());
    expect(documento.notes.join(' ')).toContain('Sin datos');
    expect(documento.kpis.find((kpi) => kpi.label === 'Grupo mayor')?.value).toBe('—');
  });
});
