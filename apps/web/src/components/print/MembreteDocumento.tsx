import { CLINIC, clinicContactLine, clinicFullAddress } from '@odontocrm/contracts';
import type { ClinicIdentity } from '@odontocrm/contracts';

import { useClinicIdentity } from '../../providers/ClinicIdentityProvider';
import { clinicLogoUrl } from '../../lib/marca';

/**
 * Membrete del consultorio para los documentos que **imprime el navegador** (la
 * historia clínica y el odontograma), con el mismo logo, nombre y datos de contacto
 * que el servidor estampa en el récipe, el dossier, el reporte y los documentos de
 * cobro.
 *
 * Los datos salen de la **identidad del consultorio** (ADR 0056): el perfil que
 * completa el titular y, mientras no exista, el respaldo del código (`CLINIC`). El
 * logo, igual: el subido o el del repositorio. Así el papel del navegador y el PDF del
 * servidor no pueden separarse. Los colores son los de la marca impresa (`--brand-*`).
 */
export interface MembreteDocumentoProps {
  /** Título del documento, a la derecha del membrete («Historia clínica», «Odontograma»). */
  title: string;
}

export const MembreteDocumento = ({ title }: MembreteDocumentoProps) => {
  const identidad = useClinicIdentity();
  // La vista trae los campos del perfil; el resto de `ClinicIdentity` no se usa aquí.
  const clinic: ClinicIdentity = {
    ...(identidad?.clinic ?? CLINIC),
    logoPath: null,
    dentists: [],
  };
  // El logo efectivo: el subido (viene ya como `data:` URI) o el del repositorio.
  const logo = identidad?.logoDataUri ?? clinicLogoUrl();

  const contacto = clinicContactLine(clinic);
  const lineas = [
    clinicFullAddress(clinic),
    clinic.rif === null ? null : `RIF ${clinic.rif}`,
    contacto === '' ? null : contacto,
    clinic.website,
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
          <p
            className="text-lg font-bold"
            style={{ color: 'var(--brand-primary)', fontFamily: 'var(--brand-font-doc-title)' }}
          >
            {clinic.name}
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
        style={{ color: 'var(--brand-primary)', fontFamily: 'var(--brand-font-doc-title)' }}
      >
        {title}
      </p>
    </header>
  );
};
