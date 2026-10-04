import {
  reportFileName,
  type ReportExportFormat,
  type ReportKey,
  type ReportRange,
} from '@odontocrm/contracts';
import { Button, cn } from '@odontocrm/ui';
import { Download, Printer } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { reportsApi, type ReportQueryParams } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { reportFileLabel } from '../../lib/reports';

export interface ReportExportBarProps {
  reportKey: ReportKey;
  /** Período que resolvió el servidor: es el que va en el nombre del archivo. */
  range: ReportRange;
  /** Los mismos filtros que la pantalla, para que el archivo coincida con lo que se ve. */
  filters: ReportQueryParams;
  onSuccess?: (mensaje: string) => void;
  onError?: (mensaje: string) => void;
  className?: string;
}

/**
 * Exportación e impresión del reporte activo.
 *
 * CSV y PDF los arma el **servidor** con los mismos filtros de la pantalla
 * (`reportToCsv` sale de la tabla del documento), así que lo descargado es
 * exactamente lo que se está viendo. Cada botón lleva su propio estado de carga
 * —y no uno compartido— para que se vea cuál se está preparando.
 *
 * La impresión es la del navegador: se imprime el documento en pantalla y los
 * controles van con `print:hidden`; el PDF bueno es el que genera el servidor.
 */
export const ReportExportBar = ({
  reportKey,
  range,
  filters,
  onSuccess,
  onError,
  className,
}: ReportExportBarProps) => {
  const [descargando, setDescargando] = useState<ReportExportFormat | null>(null);

  const descargar = async (format: ReportExportFormat): Promise<void> => {
    setDescargando(format);
    try {
      const blob = await reportsApi.exportFile(reportKey, format, filters);
      const nombre = reportFileName(reportKey, range, format);
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = nombre;
      document.body.append(enlace);
      enlace.click();
      enlace.remove();
      // Se revoca más tarde: hacerlo en el acto cancela la descarga en algunos
      // navegadores que todavía la están escribiendo en disco.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onSuccess?.(t('reportes.export.exito', { archivo: nombre }));
    } catch (fallo) {
      onError?.(apiErrorMessage(fallo));
    } finally {
      setDescargando(null);
    }
  };

  return (
    <div
      role="group"
      aria-label={t('reportes.export.titulo')}
      className={cn('flex flex-wrap items-center gap-2', className)}
    >
      <Button
        variant="secondary"
        onClick={() => void descargar('csv')}
        loading={descargando === 'csv'}
        loadingLabel={t('reportes.export.preparando')}
        disabled={descargando !== null && descargando !== 'csv'}
        leadingIcon={<Download className="size-4" aria-hidden="true" />}
        title={reportFileLabel(reportKey, 'csv')}
      >
        {t('reportes.export.csv')}
      </Button>

      <Button
        variant="secondary"
        onClick={() => void descargar('pdf')}
        loading={descargando === 'pdf'}
        loadingLabel={t('reportes.export.preparando')}
        disabled={descargando !== null && descargando !== 'pdf'}
        leadingIcon={<Download className="size-4" aria-hidden="true" />}
        title={reportFileLabel(reportKey, 'pdf')}
      >
        {t('reportes.export.pdf')}
      </Button>

      <Button
        variant="secondary"
        onClick={() => window.print()}
        leadingIcon={<Printer className="size-4" aria-hidden="true" />}
        title={t('reportes.export.imprimirAyuda')}
      >
        {t('reportes.export.imprimir')}
      </Button>
    </div>
  );
};
