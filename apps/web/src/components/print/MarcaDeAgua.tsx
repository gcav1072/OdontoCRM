import { useClinicIdentity } from '../../providers/ClinicIdentityProvider';
import { clinicLogoUrl } from '../../lib/marca';

/**
 * La **marca de agua** del papel: el logo del consultorio, centrado y translúcido,
 * detrás del documento impreso desde el navegador (la historia clínica y el
 * odontograma), con las mismas medidas que los PDF que compone el servidor
 * (`--brand-watermark-width-mm` y `--brand-watermark-opacity`).
 *
 * El logo es el **efectivo** (ADR 0056): el que subió el titular —que sirve a la vez de
 * membrete y de velo— o, si no hay, el del repositorio. La **opacidad y el ancho** sí
 * son de la marca impresa (`brand.ts`, solo-código): el titular cambia el logo, no el
 * velo.
 *
 * Solo se ve **al imprimir** (`hidden print:block`): en pantalla la vista se lee
 * limpia, pero el papel sale con el velo de la marca. Si no hay logo, no pinta nada y
 * el documento sale igual.
 *
 * El contenido del documento va en un contenedor con `relative z-[1]` para quedar
 * **por encima** del velo (si no, la marca de agua taparía el texto).
 */
export const MarcaDeAgua = () => {
  const identidad = useClinicIdentity();
  const logo = identidad?.logoDataUri ?? clinicLogoUrl();
  if (logo === null) return null;
  return (
    <img
      src={logo}
      alt=""
      aria-hidden
      className="pointer-events-none fixed top-1/2 left-1/2 z-0 hidden max-h-[82%] -translate-x-1/2 -translate-y-1/2 object-contain print:block"
      style={{
        width: 'var(--brand-watermark-width-mm)',
        opacity: 'var(--brand-watermark-opacity)',
      }}
    />
  );
};
