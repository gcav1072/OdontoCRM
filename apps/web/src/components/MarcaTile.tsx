import { cn } from '@odontocrm/ui';
import { Stethoscope } from 'lucide-react';

import { clinicLogoUrl } from '../lib/marca';

/**
 * La **marca de producto** de OdontoCRM en las pantallas: el logo del consultorio
 * (`assets/clinic/logo.svg`, el mismo del membrete impreso) dibujado con el color del
 * contenedor.
 *
 * **Por qué una máscara y no una `<img>`.** El logo es de un solo color y aquí se quiere que
 * herede `currentColor`: blanco sobre el tile teal del raíl, `text-ink` en las pantallas de
 * acceso. Una máscara CSS (`mask-image` con el **canal alfa** del SVG) pinta el logo con
 * `background-color: currentColor`, de modo que el mismo archivo sirve para todos los fondos
 * sin un segundo archivo teñido ni un `filter`. El color del SVG da igual: solo cuenta lo
 * opaco y lo transparente, y el logo ya es trazo opaco sobre fondo transparente.
 *
 * Si no hay logo (archivo ausente o `BRAND.logoPath` sin correspondencia), se cae al
 * estetoscopio de siempre: es lo mismo que hacen los imprimibles —`logoUrlFor` devuelve
 * `null` y el documento sale sin logo— en vez de romperse.
 */
export interface MarcaTileProps {
  /** Tamaño del glifo, en la escala de iconos de lucide (`size-4`, `size-5`, `size-6`…). */
  className?: string;
}

export const MarcaTile = ({ className }: MarcaTileProps) => {
  const logo = clinicLogoUrl();
  if (logo === null) return <Stethoscope aria-hidden="true" className={className} />;

  const mascara = `url("${logo}")`;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        maskImage: mascara,
        maskMode: 'alpha',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        // Safari/iOS no reconocen las propiedades sin prefijo: se declaran las dos formas.
        WebkitMaskImage: mascara,
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
      }}
    />
  );
};
