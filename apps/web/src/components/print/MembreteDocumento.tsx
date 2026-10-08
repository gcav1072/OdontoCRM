import { CLINIC, clinicContactLine, clinicFullAddress } from '@odontocrm/contracts';

import { clinicLogoUrl } from '../../lib/marca';

/**
 * Membrete del consultorio para los documentos que **imprime el navegador** (la
 * historia clínica y el odontograma), con el mismo logo, nombre y datos de contacto
 * que el servidor estampa en el récipe, el dossier, el reporte y los documentos de
 * cobro.
 *
 * Sale de la **sección editable del consultorio** (`packages/contracts/src/clinic.ts`):
 * lo que esté en `null` simplemente no se imprime, así que el membrete se ve completo
 * en cuanto se rellenan los datos. Los colores son los de la marca impresa
 * (`--brand-*`), que es lo que hace que el papel del navegador y los PDF del servidor
 * no salgan cada uno de un color.
 */
export interface MembreteDocumentoProps {
  /** Título del documento, a la derecha del membrete («Historia clínica», «Odontograma»). */
  title: string;
}

export const MembreteDocumento = ({ title }: MembreteDocumentoProps) => {
  const logo = clinicLogoUrl();
  const contacto = clinicContactLine();
  const lineas = [
    clinicFullAddress(),
    CLINIC.rif === null ? null : `RIF ${CLINIC.rif}`,
    contacto === '' ? null : contacto,
    CLINIC.website,
  ].filter((linea): linea is string => linea !== null && linea.trim() !== '');

  return (
    <header
      className="flex flex-wrap items-start justify-between gap-4 border-b pb-3"
      style={{ borderColor: 'var(--brand-accent)' }}
    >
      <div className="flex items-start gap-4">
        {logo !== null && (
          // El alto lo fija la marca (`--brand-logo-height-mm`), la misma medida del PDF.
          <img
            src={logo}
            alt=""
            aria-hidden
            className="h-[var(--brand-logo-height-mm)] w-auto shrink-0"
          />
        )}
        <div>
          <p className="text-lg font-bold" style={{ color: 'var(--brand-primary)' }}>
            {CLINIC.name}
          </p>
          {lineas.map((linea) => (
            <p key={linea} className="text-xs" style={{ color: 'var(--brand-ink-muted)' }}>
              {linea}
            </p>
          ))}
        </div>
      </div>
      <p
        className="text-sm font-semibold tracking-wide uppercase"
        style={{ color: 'var(--brand-primary)' }}
      >
        {title}
      </p>
    </header>
  );
};
