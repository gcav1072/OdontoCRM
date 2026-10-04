import {
  CLINICAL_PROFILE_GROUPS,
  clinicalProfileCounts,
  type ReportDocument,
  type ReportRow,
} from '@odontocrm/contracts';
import { and, isNotNull, isNull, sql } from 'drizzle-orm';

import { dimPatient } from '../db/schema.js';
import {
  columna,
  condicionesDePaciente,
  documento,
  enRango,
  kpi,
  notaDeFiltros,
  porcentaje,
  punto,
  serie,
  sinDatos,
  tabla,
  type ReportContext,
  type ReportDeps,
} from './shared.js';

/**
 * Reporte del **perfil clínico agregado** (plan §13, Fase 9): cuántos pacientes hay
 * con diabetes, hipertensión, cardiopatía, alergias, anticoagulados, bifosfonatos y
 * otros antecedentes.
 *
 * Los grupos salen del contrato (`CLINICAL_PROFILE_GROUPS`) y se cuentan sobre los
 * **códigos de alerta clínica** que ya calcula la historia clínica: los publica
 * `clinical.record.created|updated|signed` en su bloque `profile.alertCodes`. Un
 * paciente puede caer en varios grupos (diabético e hipertenso), así que los
 * porcentajes no suman 100 a propósito.
 *
 * **Qué significa el rango de fechas aquí:** cuenta pacientes con **visita en el
 * período** (última visita entre el primero y el último día), que es la lectura útil
 * de «los crónicos que he visto este mes». Está dicho en las notas del documento.
 */

export interface FilaPerfil {
  patientId: string;
  alerts: readonly string[];
  recordStatus: string | null;
}

/**
 * Compone el documento. **Pura**: usa `clinicalProfileCounts` del contrato, así que
 * la definición de «diabético» es la misma que la del resto del sistema.
 */
export const componerPerfilClinico = (
  filas: readonly FilaPerfil[],
  ctx: ReportContext,
): ReportDocument => {
  const total = filas.length;
  const conteos = clinicalProfileCounts(filas.map((fila) => fila.alerts));
  const conHistoria = filas.filter((fila) => fila.recordStatus !== null).length;
  const firmadas = filas.filter((fila) => fila.recordStatus === 'firmada').length;
  const conAlgunaAlerta = filas.filter((fila) => fila.alerts.length > 0).length;

  const filasTabla: ReportRow[] = CLINICAL_PROFILE_GROUPS.map((grupo) => ({
    grupo: grupo.label,
    pacientes: conteos[grupo.key],
    porcentaje: porcentaje(conteos[grupo.key], total),
  }));

  const puntos = CLINICAL_PROFILE_GROUPS.map((grupo) => punto(grupo.label, conteos[grupo.key]));

  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (total === 0) notes.push(sinDatos(ctx));
  notes.push(
    'El rango de fechas cuenta pacientes con visita en el período (citas atendidas, sesiones clínicas y récipes).',
  );
  if (total > 0 && conHistoria < total) {
    notes.push(
      `${String(total - conHistoria)} de los ${String(total)} pacientes del período no tienen historia clínica abierta: no aportan alertas al perfil.`,
    );
  }
  notes.push(
    'Un paciente puede aparecer en varios grupos (por ejemplo, diabético y anticoagulado): los porcentajes se calculan sobre el total de pacientes y no suman 100.',
  );

  const grupoMayor = CLINICAL_PROFILE_GROUPS.reduce<{ label: string; valor: number }>(
    (mayor, grupo) =>
      conteos[grupo.key] > mayor.valor ? { label: grupo.label, valor: conteos[grupo.key] } : mayor,
    { label: '—', valor: 0 },
  );

  return documento('clinical-profile', ctx, {
    kpis: [
      kpi('Pacientes atendidos', total, { hint: 'con la última visita en el período' }),
      kpi('Con antecedentes', conAlgunaAlerta, {
        hint: `${String(porcentaje(conAlgunaAlerta, total))} % del total`,
      }),
      kpi('Historias firmadas', firmadas, {
        hint: `${String(conHistoria)} historias abiertas`,
      }),
      kpi('Grupo mayor', grupoMayor.label, {
        hint: `${String(grupoMayor.valor)} pacientes`,
      }),
    ],
    series: [serie('grupos', 'Pacientes por grupo clínico', 'bar', puntos)],
    table: tabla(
      [
        columna('grupo', 'Grupo'),
        columna('pacientes', 'Pacientes', 'number'),
        columna('porcentaje', 'Porcentaje', 'number'),
      ],
      filasTabla,
    ),
    notes,
  });
};

/* ── Proyección ────────────────────────────────────────────────────────────── */

/**
 * El perfil clínico se lee **siempre** de `dim_patient`: no hay vista materializada
 * de alertas (son un array por paciente y el número de pacientes es pequeño). El
 * rango filtra por última visita.
 */
const proyectarPerfil = async (deps: ReportDeps, ctx: ReportContext): Promise<FilaPerfil[]> => {
  const filas = await deps.db
    .select({
      patientId: dimPatient.patientId,
      alerts: dimPatient.profileAlerts,
      recordStatus: dimPatient.recordStatus,
    })
    .from(dimPatient)
    .where(
      and(
        isNull(dimPatient.deletedAt),
        isNotNull(dimPatient.lastVisitAt),
        enRango(sql`${dimPatient.lastVisitAt}::date`, ctx.range),
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    );

  return filas;
};

export const buildClinicalProfileReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => componerPerfilClinico(await proyectarPerfil(deps, ctx), ctx);
