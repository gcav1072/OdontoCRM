import { fontStackFor, type BrandSettings } from '@odontocrm/contracts';
import { Field, Input, Select } from '@odontocrm/ui';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';

/**
 * Pesos que se ofrecen al subir una fuente. Son los múltiplos de 100 de la
 * especificación `font-weight`: 400 es el cuerpo normal y 700 el de los títulos.
 */
export const PESOS_FUENTE = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/** La opción del desplegable cuando la pila no es ninguna familia declarada. */
const FAMILIA_PERSONALIZADA = '__personalizada__';

/** El nombre de la familia que abre una pila (`'Montserrat', …` → `Montserrat`). */
export const familiaDeLaPila = (pila: string): string =>
  (pila.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '');

/** Las familias que el panel ofrece en los desplegables. */
type FamiliasVista = BrandSettings['fonts']['families'];

/** La muestra que se dibuja con la fuente y el peso elegidos. */
export interface RolTipograficoProps {
  etiqueta: string;
  pila: string;
  peso: number;
  familias: FamiliasVista;
  muestra: ReactNode;
  onPila: (pila: string) => void;
  onPeso: (peso: number) => void;
  /** Error de validación de la pila (p. ej. vacía), para no enviarla al servidor. */
  error?: string;
}

/**
 * Un **rol** de la tipografía (títulos, cuerpo o el nombre del membrete): desplegable de
 * familia, desplegable de peso, **vista previa** con la elección al instante y un bloque
 * **avanzado** para editar la pila CSS a mano. Elegir una familia escribe
 * `fontStackFor(familia)` en la pila; si la pila no es ninguna familia declarada, el
 * desplegable se pone en «Personalizada».
 *
 * Vive en su propio archivo porque lo usan la marca de los documentos y la subsección del
 * membrete: las dos eligen familia y peso de la **misma** lista de fuentes.
 */
export const RolTipografico = ({
  etiqueta,
  pila,
  peso,
  familias,
  muestra,
  onPila,
  onPeso,
  error,
}: RolTipograficoProps): ReactNode => {
  const familia = familiaDeLaPila(pila);
  const conocida = familias.some((una) => una.name === familia);
  const elegida = familias.find((una) => una.name === familia);
  const pesos =
    elegida === undefined
      ? [...PESOS_FUENTE]
      : [...new Set(elegida.files.map((file) => file.weight))].sort((a, b) => a - b);

  return (
    <div className="space-y-3 rounded-control border border-border p-3">
      <h4 className="text-sm font-semibold text-ink">{etiqueta}</h4>
      <div className="grid gap-3 @2xl:grid-cols-2">
        <Field label={t('config.marca.familia')}>
          <Select
            value={conocida ? familia : FAMILIA_PERSONALIZADA}
            onChange={(event) => {
              const valor = event.target.value;
              if (valor !== FAMILIA_PERSONALIZADA) onPila(fontStackFor(valor));
            }}
          >
            {familias.map((una) => (
              <option key={una.name} value={una.name}>
                {una.name}
              </option>
            ))}
            <option value={FAMILIA_PERSONALIZADA}>{t('config.marca.personalizada')}</option>
          </Select>
        </Field>
        <Field label={t('config.marca.peso')}>
          <Select value={String(peso)} onChange={(event) => onPeso(Number(event.target.value))}>
            {pesos.map((valor) => (
              <option key={valor} value={valor}>
                {valor}
                {valor === 400 ? ' · normal' : valor === 700 ? ' · negrita' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <p className="mb-1 text-xs text-ink-subtle">{t('config.marca.vistaPrevia')}</p>
        <div
          className="rounded-control border border-dashed border-border bg-surface-muted px-3 py-2 text-ink"
          style={{ fontFamily: pila, fontWeight: peso }}
        >
          {muestra}
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-xs text-ink-muted">
          {t('config.marca.avanzado')}
        </summary>
        <div className="pt-2">
          <Field
            label={t('config.marca.pilaPersonalizada')}
            hint={error === undefined ? t('config.marca.pilaAyuda') : undefined}
            error={error}
          >
            <Input
              value={pila}
              onChange={(event) => onPila(event.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      </details>
    </div>
  );
};
