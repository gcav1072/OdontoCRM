import type { ClinicalRecordDetail, ClinicalSectionKey } from '@odontocrm/contracts';
import { Badge } from '@odontocrm/ui';

import { formatDate } from '../../lib/format';
import {
  CLINICAL_SECTION_FIELDS,
  CLINICAL_SECTION_ORDER,
  clinicalAlertLabel,
  clinicalCatalogItemLabel,
  clinicalCatalogTitle,
  clinicalFieldLabel,
  clinicalOptionLabel,
  clinicalPriorityLabel,
  clinicalSectionLabel,
  clinicalStatusLabel,
  type ClinicalFieldSpec,
} from '../../lib/clinical';
import { t } from '../../lib/i18n';
import { MarcaDeAgua } from '../print/MarcaDeAgua';
import { MembreteDocumento } from '../print/MembreteDocumento';

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const formatFieldValue = (field: ClinicalFieldSpec, value: unknown): string => {
  switch (field.kind) {
    case 'checkbox':
      return value === true ? t('comun.si') : t('comun.no');
    case 'date': {
      const text = asText(value);
      return text === '' ? t('comun.sinDato') : formatDate(text);
    }
    case 'select': {
      const text = asText(value);
      return text === '' ? t('comun.sinDato') : clinicalOptionLabel(field.group, text);
    }
    case 'catalog': {
      if (typeof value !== 'object' || value === null) return t('comun.sinDato');
      const items = (value as { items?: unknown }).items;
      const otros = asText((value as { otros?: unknown }).otros);
      const parts = Array.isArray(items)
        ? items
            .filter((item): item is string => typeof item === 'string')
            .map((code) => clinicalCatalogItemLabel(field.group, code))
        : [];
      if (otros !== '') parts.push(`${clinicalCatalogItemLabel(field.group, 'otros')}: ${otros}`);
      return parts.length === 0 ? t('comun.sinDato') : parts.join(', ');
    }
    case 'procedures': {
      if (!Array.isArray(value) || value.length === 0) return t('comun.sinDato');
      return value
        .map((item) => {
          const row = (typeof item === 'object' && item !== null ? item : {}) as Record<
            string,
            unknown
          >;
          const descripcion = asText(row['descripcion']);
          const prioridad = asText(row['prioridad']);
          const pieza = asText(row['pieza']);
          const presupuesto = typeof row['presupuesto'] === 'number' ? row['presupuesto'] : null;
          const detalles = [
            prioridad === '' ? null : clinicalPriorityLabel(prioridad),
            pieza === '' ? null : `${t('clinica.plan.pieza')} ${pieza}`,
            presupuesto === null ? null : `${presupuesto}`,
          ].filter((detail): detail is string => detail !== null);
          return detalles.length === 0 ? descripcion : `${descripcion} (${detalles.join(' · ')})`;
        })
        .join('; ');
    }
    default: {
      const text = asText(value);
      return text === '' ? t('comun.sinDato') : text;
    }
  }
};

const hasAnyValue = (
  fields: readonly ClinicalFieldSpec[],
  content: Record<string, unknown>,
): boolean =>
  fields.some((field) => {
    const formatted = formatFieldValue(field, content[field.name]);
    return formatted !== t('comun.sinDato') && formatted !== t('comun.no');
  });

/**
 * Tinta del papel: las variables de la **marca** (`packages/contracts/src/brand.ts`),
 * las mismas que usan el récipe, el dossier y el reporte que compone el servidor. La
 * historia clínica impresa desde el navegador no puede salir con colores distintos a
 * los de su propio récipe.
 */
const TINTA = { color: 'var(--brand-ink)' } as const;
const TINTA_MUTED = { color: 'var(--brand-ink-muted)' } as const;
const TINTA_STRONG = { color: 'var(--brand-ink-strong)' } as const;
const TINTA_BAD = { color: 'var(--brand-bad)' } as const;
const TITULO = { color: 'var(--brand-primary)' } as const;
const LINEA = { borderColor: 'var(--brand-line)' } as const;
const LINEA_SUAVE = { borderColor: 'var(--brand-line-soft)' } as const;

/**
 * Historia clínica en formato de documento (A4): la misma vista sirve para la
 * impresión que para leer el historial en pantalla. No lleva controles: los
 * pone quien la use.
 */
export const MedicalRecordDocument = ({ record }: { record: ClinicalRecordDetail }) => {
  const sections = CLINICAL_SECTION_ORDER.filter((key) => {
    const content = record.sections[key];
    return content !== undefined && hasAnyValue(CLINICAL_SECTION_FIELDS[key], content);
  });

  return (
    <article
      className="relative mx-auto w-full max-w-[21cm] bg-white px-8 py-10 print:max-w-none print:px-0 print:py-0"
      style={TINTA}
    >
      <MarcaDeAgua />
      {/* Todo lo que va sobre el velo de la marca de agua queda por encima (`z-[1]`). */}
      <div className="relative z-[1]">
        <MembreteDocumento title={t('clinica.documento.titulo')} />

        <header className="mt-4 border-b pb-4" style={LINEA}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div>
                <dt style={TINTA_MUTED}>{t('clinica.documento.paciente')}</dt>
                <dd className="font-medium">{record.patient?.fullName ?? '—'}</dd>
              </div>
              <div>
                <dt style={TINTA_MUTED}>{t('pacientes.campo.docNumber')}</dt>
                <dd className="font-medium">{record.patient?.document ?? '—'}</dd>
              </div>
              <div>
                <dt style={TINTA_MUTED}>{t('clinica.documento.edad')}</dt>
                <dd className="font-medium">
                  {record.patient === null ? '—' : `${record.patient.age}`}
                </dd>
              </div>
              <div>
                <dt style={TINTA_MUTED}>{t('pacientes.campo.phone')}</dt>
                <dd className="font-medium">{record.patient?.phone ?? '—'}</dd>
              </div>
              <div className="col-span-2">
                <dt style={TINTA_MUTED}>{t('pacientes.campo.address')}</dt>
                <dd className="font-medium">{record.patient?.address ?? '—'}</dd>
              </div>
            </dl>
            <div className="text-right text-sm">
              <Badge variant={record.status === 'firmada' ? 'success' : 'info'}>
                {clinicalStatusLabel(record.status)}
              </Badge>
              <p className="mt-1" style={TINTA_MUTED}>
                {t('clinica.documento.abierta', { fecha: formatDate(record.openedAt) })}
              </p>
              {record.signedAt && (
                <p style={TINTA_MUTED}>
                  {t('clinica.documento.firmada', {
                    fecha: formatDate(record.signedAt),
                    usuario: record.signedByUsername ?? '',
                  })}
                </p>
              )}
            </div>
          </div>
        </header>

        {record.alerts.length > 0 && (
          <p className="mt-3 text-sm font-semibold" style={TINTA_BAD}>
            {t('clinica.alertas.titulo')}: {record.alerts.map(clinicalAlertLabel).join(' · ')}
          </p>
        )}

        <div className="mt-6 space-y-6">
          {sections.map((key: ClinicalSectionKey) => (
            <section key={key} className="break-inside-avoid">
              <h2
                className="border-b pb-1 text-base font-semibold"
                style={{ ...TITULO, ...LINEA_SUAVE }}
              >
                {clinicalSectionLabel(key)}
              </h2>
              <dl className="mt-2 space-y-1 text-sm">
                {CLINICAL_SECTION_FIELDS[key].map((field) => {
                  const value = formatFieldValue(field, record.sections[key]?.[field.name]);
                  return (
                    <div key={field.name} className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-2">
                      <dt style={TINTA_MUTED}>{clinicalFieldLabel(field.labelKey)}</dt>
                      <dd className="whitespace-pre-wrap">
                        {field.kind === 'catalog' && value !== t('comun.sinDato')
                          ? `${clinicalCatalogTitle(field.group)}: ${value}`
                          : value}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}
        </div>

        {record.consent && (
          <section className="mt-6 break-inside-avoid">
            <h2
              className="border-b pb-1 text-base font-semibold"
              style={{ ...TITULO, ...LINEA_SUAVE }}
            >
              {t('clinica.consentimiento.titulo')}
            </h2>
            <p className="mt-2 text-sm">
              {t('clinica.consentimiento.aceptadoPor', {
                nombre: record.consent.acceptedByName ?? '',
                relacion: record.consent.relationship ?? '',
              })}
              {record.consent.acceptedAt && ` · ${formatDate(record.consent.acceptedAt)}`}
              {record.consent.witnessName
                ? ` · ${t('clinica.consentimiento.testigo')}: ${record.consent.witnessName}`
                : ''}
            </p>
          </section>
        )}

        {record.amendments.length > 0 && (
          <section className="mt-6 break-inside-avoid">
            <h2
              className="border-b pb-1 text-base font-semibold"
              style={{ ...TITULO, ...LINEA_SUAVE }}
            >
              {t('clinica.adenda.titulo')}
            </h2>
            <ul className="mt-2 space-y-2 text-sm">
              {record.amendments.map((amendment) => (
                <li key={amendment.id}>
                  <p className="font-medium">
                    {formatDate(amendment.createdAt)} ·{' '}
                    {amendment.sectionKey === null
                      ? t('clinica.adenda.general')
                      : clinicalSectionLabel(amendment.sectionKey)}
                  </p>
                  <p style={TINTA_STRONG}>{amendment.content}</p>
                  <p style={TINTA_MUTED}>
                    {t('clinica.adenda.motivo')}: {amendment.reason}
                    {amendment.authorUsername ? ` · ${amendment.authorUsername}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-10 border-t pt-6 text-xs" style={{ ...LINEA, ...TINTA_MUTED }}>
          <p>{t('clinica.documento.pie')}</p>
          <div className="mt-10 grid grid-cols-2 gap-10">
            <p
              className="border-t pt-1 text-center"
              style={{ borderColor: 'var(--brand-ink-muted)' }}
            >
              {t('clinica.documento.firmaPaciente')}
            </p>
            <p
              className="border-t pt-1 text-center"
              style={{ borderColor: 'var(--brand-ink-muted)' }}
            >
              {t('clinica.documento.firmaOdontologo')}
            </p>
          </div>
        </footer>
      </div>
    </article>
  );
};
