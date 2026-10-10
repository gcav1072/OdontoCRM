import {
  CLINIC,
  clinicContactLine,
  clinicDentistFor,
  clinicDentistLine,
  clinicFullAddress,
  clinicIdentityFromView,
} from '@odontocrm/contracts';
import type { ClinicIdentity } from '@odontocrm/contracts';

import { useOptionalAuth } from '../../providers/AuthProvider';
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
 *
 * La **línea del especialista** (Odontólogo · Especialidad · MPPS · Colegiatura) va
 * bajo la dirección y el teléfono: es quien responde por el documento. Se resuelve por
 * el **usuario que imprime**, con el titular como respaldo —la misma regla que usa el
 * servidor al emitir—.
 */
export interface MembreteDocumentoProps {
  /** Título del documento, a la derecha del membrete («Historia clínica», «Odontograma»). */
  title: string;
}

export const MembreteDocumento = ({ title }: MembreteDocumentoProps) => {
  const identidad = useClinicIdentity();
  // Fuera del shell (pruebas) no hay sesión: el membrete cae al titular sin reventar.
  const sesion = useOptionalAuth();
  // La vista trae el perfil del consultorio y sus odontólogos en la forma del contrato,
  // para reutilizar `clinicDentistFor` / `clinicDentistLine`. Sin vista, el respaldo.
  const clinic: ClinicIdentity = identidad === null ? CLINIC : clinicIdentityFromView(identidad);
  // El logo efectivo: el subido (viene ya como `data:` URI) o el del repositorio.
  const logo = identidad?.logoDataUri ?? clinicLogoUrl();

  const contacto = clinicContactLine(clinic);
  const lineas = [
    clinicFullAddress(clinic),
    clinic.rif === null ? null : `RIF ${clinic.rif}`,
    contacto === '' ? null : contacto,
    clinic.website,
  ].filter((linea): linea is string => linea !== null && linea.trim() !== '');
  // El odontólogo que responde por el papel: el que imprime (o el titular).
  const lineaDentista = clinicDentistLine(clinicDentistFor(sesion?.user?.username, clinic));

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
          {lineaDentista !== '' && (
            <p className="text-xs" style={{ color: 'var(--brand-ink-strong)' }}>
              {lineaDentista}
            </p>
          )}
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
