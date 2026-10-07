import { Input } from '@odontocrm/ui';
import { Ruler } from 'lucide-react';
import { useEffect, useState } from 'react';

import { t } from '../../lib/i18n';
import { MARGEN_MAX_MM, MARGEN_MIN_MM, normalizarMargen } from '../../lib/impresion';

/**
 * El ajuste del margen del papel, para la barra de las vistas de impresión
 * (odontograma e historia clínica). El tamaño de hoja está fijado en **carta**; lo
 * que se elige aquí es cuánto blanco deja el borde antes del contenido.
 *
 * El valor viaja en milímetros y se aplica a la regla `@page` mientras la vista está
 * montada (ver `useMargenDeImpresion`), así que lo que se ve al pulsar «Imprimir» es
 * exactamente lo elegido.
 */
export interface MargenDeImpresionProps {
  margenMm: number;
  onChange: (margenMm: number) => void;
}

export const MargenDeImpresion = ({ margenMm, onChange }: MargenDeImpresionProps) => {
  /*
   * El campo se edita como **texto**: si se escuchara el número en crudo, borrar para
   * teclear otro valor lo repondría al mínimo y no dejaría escribir («20» sería imposible).
   */
  const [texto, setTexto] = useState(String(margenMm));

  // Si el margen cambia desde fuera, el campo se sincroniza.
  useEffect(() => {
    setTexto(String(margenMm));
  }, [margenMm]);

  const editar = (valor: string): void => {
    setTexto(valor);
    const numero = Number.parseInt(valor, 10);
    // Solo se aplica en vivo lo que ya es un margen válido.
    if (Number.isInteger(numero) && numero >= MARGEN_MIN_MM && numero <= MARGEN_MAX_MM) {
      onChange(numero);
    }
  };

  // Al salir del campo se normaliza: lo que no valga vuelve al margen vigente.
  const confirmar = (): void => {
    const numero = normalizarMargen(texto);
    setTexto(String(numero));
    onChange(numero);
  };

  return (
    <label className="flex items-center gap-2 text-sm text-ink-muted">
      <Ruler className="size-4" aria-hidden />
      <span>{t('impresion.margen')}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={MARGEN_MIN_MM}
        max={MARGEN_MAX_MM}
        className="w-16 text-center"
        value={texto}
        aria-label={t('impresion.margen')}
        title={t('impresion.margenAyuda')}
        onChange={(evento) => editar(evento.target.value)}
        onBlur={confirmar}
      />
      <span className="text-xs text-ink-subtle">{t('impresion.margenUnidad')}</span>
    </label>
  );
};
