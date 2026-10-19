import {
  BRAND,
  CLINIC,
  buildLetterheadView,
  clinicDentistFor,
  clinicDentistLine,
  clinicIdentityFromView,
} from '@odontocrm/contracts';
import type { ClinicIdentity } from '@odontocrm/contracts';

import { useOptionalAuth } from '../../providers/AuthProvider';
import { useClinicIdentity } from '../../providers/ClinicIdentityProvider';
import { useSettings } from '../../providers/SettingsProvider';
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
  // La **presentación** del membrete (alto del logo, tipografía del nombre, líneas y pie)
  // sale del panel; sin proveedor (pruebas) se cae al respaldo de la marca.
  const ajustes = useSettings();
  // Fuera del shell (pruebas) no hay sesión: el membrete cae al titular sin reventar.
  const sesion = useOptionalAuth();
  // La vista trae el perfil del consultorio y sus odontólogos en la forma del contrato,
  // para reutilizar `clinicDentistFor` / `clinicDentistLine`. Sin vista, el respaldo.
  const clinic: ClinicIdentity = identidad === null ? CLINIC : clinicIdentityFromView(identidad);
  // El logo efectivo: el subido (viene ya como `data:` URI) o el del repositorio.
  const logo = identidad?.logoDataUri ?? clinicLogoUrl();

  // El odontólogo que responde por el papel: el que imprime (o el titular).
  const lineaDentista = clinicDentistLine(clinicDentistFor(sesion?.user?.username, clinic));
  // El mismo helper que usan el récipe, el dossier, el reporte y los documentos de cobro:
  // el membrete de la pantalla no puede separarse del papel (ADR 0064).
  const membrete = buildLetterheadView(
    clinic,
    lineaDentista === '' ? null : lineaDentista,
    ajustes?.brand.letterhead ?? BRAND.letterhead,
    { subtitle: clinic.legalName },
  );

  return (
    <header
      className="flex flex-wrap items-start justify-between gap-4 border-b pb-3"
      style={{ borderColor: 'var(--brand-accent)' }}
    >
      <div className="brand-lh">
        {logo !== null && (
          /* El logo se dimensiona con la marca (`--brand-logo-height-mm`), igual que
             en `.brand-lh-logo` del servidor. Sin esta medida, el `<img>` se pintaba
             a su tamaño natural y el membrete se comía media hoja: en el
             periodontograma empujaba la mandíbula a la página siguiente. */
          <img
            src={logo}
            alt=""
            aria-hidden
            className="brand-lh-logo h-[var(--brand-logo-height-mm)] w-auto shrink-0"
          />
        )}
        <div className="brand-lh-body">
          <p className="brand-lh-name">{membrete.name}</p>
          {membrete.subtitle !== null && <p className="brand-lh-line">{membrete.subtitle}</p>}
          {membrete.lines.map((linea) => (
            <p
              key={linea.key}
              className={
                linea.key === 'dentist' ? 'brand-lh-line brand-lh-dentist' : 'brand-lh-line'
              }
            >
              {linea.text}
            </p>
          ))}
          {membrete.footer !== null && <p className="brand-lh-footer">{membrete.footer}</p>}
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
