import {
  bookFileName,
  rangoDelMes,
  rangoDelMesAnterior,
  type BookQuery,
  type BooksSummary,
} from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from '@odontocrm/ui';
import { BookOpen, Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { formatBs, formatUsd } from '../../lib/caja';
import { billingApi } from '../../lib/endpoints';
import { t, type TranslationKey } from '../../lib/i18n';
import { formatDateOnly, todayInClinic } from '../../lib/scheduling';

export interface LibrosFiscalesPanelProps {
  /** La descarga terminó: la caja pone el aviso. */
  onDone: (mensaje: string) => void;
  /** Fallo de red o del servidor, ya traducido. */
  onError: (mensaje: string) => void;
}

/** Los tres libros, en el orden en que se entregan al contador. */
const LIBROS = [
  {
    tipo: 'ventas',
    titulo: 'caja.libros.ventas.titulo',
    ayuda: 'caja.libros.ventas.ayuda',
  },
  {
    tipo: 'cambiario',
    titulo: 'caja.libros.cambiario.titulo',
    ayuda: 'caja.libros.cambiario.ayuda',
  },
  {
    tipo: 'igtf',
    titulo: 'caja.libros.igtf.titulo',
    ayuda: 'caja.libros.igtf.ayuda',
  },
] as const satisfies readonly {
  tipo: 'ventas' | 'cambiario' | 'igtf';
  titulo: TranslationKey;
  ayuda: TranslationKey;
}[];

type TipoDeLibro = (typeof LIBROS)[number]['tipo'];
type Formato = 'csv' | 'pdf';

/** Un período es válido si tiene las dos fechas y la inicial no pasa la final (`aaaa-mm-dd`). */
const rangoValido = (rango: BookQuery): boolean =>
  rango.from !== undefined &&
  rango.to !== undefined &&
  rango.from !== '' &&
  rango.to !== '' &&
  rango.from <= rango.to;

const Indicador = ({ etiqueta, valor }: { etiqueta: string; valor: string }) => (
  <div className="rounded-control border border-border bg-surface-muted px-3 py-2">
    <dt className="text-xs text-ink-subtle">{etiqueta}</dt>
    <dd className="tabular-nums text-lg font-semibold text-ink">{valor}</dd>
  </div>
);

/**
 * **Libros fiscales** en la caja: el período, el resumen que cuadra y los tres libros para descargar.
 *
 * El CSV es el archivo que se lleva al contador (Excel en español: `;` y coma decimal); el PDF es el
 * mismo libro con el **membrete del consultorio** para imprimirlo o firmarlo. Los dos los compone el
 * servidor con la misma consulta, así que las cifras no pueden discrepar.
 *
 * El período se propone con `rangoDelMes` (contracts) —la misma función con la que el servidor
 * resuelve el rango por defecto—, así que «el mes en curso» significa lo mismo en las dos puntas. Las
 * fechas se muestran con `formatDateOnly`: pasarlas por `Date` las correría un día en Caracas.
 */
export const LibrosFiscalesPanel = ({ onDone, onError }: LibrosFiscalesPanelProps) => {
  const [rango, setRango] = useState<BookQuery>(() => rangoDelMes(todayInClinic()));
  const [descargando, setDescargando] = useState<string | null>(null);
  const valido = rangoValido(rango);

  const resumen = useQuery({
    queryKey: ['billing', 'libros', rango.from, rango.to],
    queryFn: ({ signal }) => billingApi.books.summary(rango, signal),
    enabled: valido,
  });

  const descargar = async (tipo: TipoDeLibro, formato: Formato): Promise<void> => {
    // Una descarga a la vez: dos clics rápidos pedirían el mismo archivo dos veces.
    if (descargando !== null || !valido) return;

    const llave = `${tipo}-${formato}`;
    setDescargando(llave);
    try {
      const pedir = {
        'ventas-csv': billingApi.books.salesCsv,
        'ventas-pdf': billingApi.books.salesPdf,
        'cambiario-csv': billingApi.books.exchangeDiffCsv,
        'cambiario-pdf': billingApi.books.exchangeDiffPdf,
        'igtf-csv': billingApi.books.igtfCsv,
        'igtf-pdf': billingApi.books.igtfPdf,
      }[`${tipo}-${formato}` as `${TipoDeLibro}-${Formato}`];

      const blob = await pedir(rango);
      const nombre = bookFileName(tipo, rango, formato);
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = nombre;
      document.body.append(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
      onDone(t('caja.libros.descargado', { nombre }));
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setDescargando(null);
    }
  };

  const aplicar = (nuevo: BookQuery): void => setRango(nuevo);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="gap-3 @2xl:flex-row @2xl:items-start @2xl:justify-between">
          <div className="min-w-0">
            <CardTitle as="h2" className="flex items-center gap-2">
              <BookOpen className="size-4 text-primary" aria-hidden="true" />
              {t('caja.libros.titulo')}
            </CardTitle>
            <p className="pt-1 text-sm text-ink-muted">{t('caja.libros.texto')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => aplicar(rangoDelMes(todayInClinic()))}
            >
              {t('caja.libros.mesActual')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => aplicar(rangoDelMesAnterior(todayInClinic()))}
            >
              {t('caja.libros.mesAnterior')}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 @2xl:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">{t('caja.libros.desde')}</span>
              <Input
                type="date"
                value={rango.from ?? ''}
                onChange={(evento) =>
                  setRango((actual) => ({ ...actual, from: evento.target.value }))
                }
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">{t('caja.libros.hasta')}</span>
              <Input
                type="date"
                value={rango.to ?? ''}
                onChange={(evento) =>
                  setRango((actual) => ({ ...actual, to: evento.target.value }))
                }
              />
            </label>
          </div>

          {!valido && <Alert variant="warning">{t('caja.libros.rangoInvalido')}</Alert>}

          <p className="text-xs text-ink-subtle">
            {valido && rango.from !== undefined && rango.to !== undefined
              ? t('caja.libros.periodo', {
                  desde: formatDateOnly(rango.from),
                  hasta: formatDateOnly(rango.to),
                })
              : t('caja.libros.periodoAyuda')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t('caja.libros.descargas')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 @3xl:grid-cols-3">
            {LIBROS.map((libro) => (
              <section
                key={libro.tipo}
                className="flex flex-col gap-3 rounded-control border border-line p-3"
              >
                <div className="min-w-0">
                  <h3 className="font-medium text-ink">{t(libro.titulo)}</h3>
                  <p className="pt-1 text-xs text-ink-muted">{t(libro.ayuda)}</p>
                </div>
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!valido || descargando !== null}
                    loading={descargando === `${libro.tipo}-csv`}
                    loadingLabel={t('caja.libros.descargando')}
                    onClick={() => void descargar(libro.tipo, 'csv')}
                    leadingIcon={<FileSpreadsheet className="size-4" aria-hidden="true" />}
                  >
                    {t('caja.libros.csv')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!valido || descargando !== null}
                    loading={descargando === `${libro.tipo}-pdf`}
                    loadingLabel={t('caja.libros.descargando')}
                    onClick={() => void descargar(libro.tipo, 'pdf')}
                    leadingIcon={<Download className="size-4" aria-hidden="true" />}
                  >
                    {t('caja.libros.pdf')}
                  </Button>
                </div>
              </section>
            ))}
          </div>
          <p className="pt-3 text-xs text-ink-subtle">{t('caja.libros.formatoAyuda')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t('caja.libros.resumen')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!valido ? null : resumen.isPending ? (
            <Spinner label={t('caja.libros.cargando')} showLabel />
          ) : resumen.isError ? (
            <Alert variant="danger" title={t('caja.libros.error')}>
              {apiErrorMessage(resumen.error)}
            </Alert>
          ) : (
            <ResumenDelPeriodo resumen={resumen.data} />
          )}
        </CardContent>
      </Card>
    </div>
  );
};

/** Los dos resúmenes que el contador cuadra: el neto cambiario y el arqueo del IGTF. */
const ResumenDelPeriodo = ({ resumen }: { resumen: BooksSummary }) => {
  const { exchangeDiff, igtf } = resumen;
  const sinIgtf =
    igtf.igtfCentsUsd === 0 && igtf.igtfVesCentimos === 0 && igtf.baseDivisasCentsUsd === 0;

  return (
    <>
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">{t('caja.libros.resumen.cambiario')}</h3>
        <dl className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
          <Indicador
            etiqueta={t('caja.libros.ganancias')}
            valor={`Bs. ${formatBs(exchangeDiff.gananciasVesCentimos)}`}
          />
          <Indicador
            etiqueta={t('caja.libros.perdidas')}
            valor={`Bs. ${formatBs(exchangeDiff.perdidasVesCentimos)}`}
          />
          <Indicador
            etiqueta={t('caja.libros.reversiones')}
            valor={`Bs. ${formatBs(exchangeDiff.reversionesVesCentimos)}`}
          />
          <Indicador
            etiqueta={t('caja.libros.neto')}
            valor={`Bs. ${formatBs(exchangeDiff.netoVesCentimos)}`}
          />
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">{t('caja.libros.resumen.igtf')}</h3>
        {sinIgtf ? (
          <Alert variant="info">{t('caja.libros.sinIgtf')}</Alert>
        ) : (
          <dl className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
            <Indicador
              etiqueta={t('caja.libros.baseDivisas')}
              valor={`US$ ${formatUsd(igtf.baseDivisasCentsUsd)}`}
            />
            <Indicador
              etiqueta={t('caja.libros.igtfCausado')}
              valor={`US$ ${formatUsd(igtf.igtfCentsUsd)}`}
            />
            <Indicador
              etiqueta={t('caja.libros.igtfCajaDivisas')}
              valor={`US$ ${formatUsd(igtf.igtfCajaDivisasCentsUsd)}`}
            />
            <Indicador
              etiqueta={t('caja.libros.igtfCajaBs')}
              valor={`Bs. ${formatBs(igtf.igtfCajaBsVesCentimos)}`}
            />
          </dl>
        )}
      </section>
    </>
  );
};
