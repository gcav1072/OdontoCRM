import { Button } from '@odontocrm/ui';
import { Download } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { exportFileName } from '../../lib/audit';
import { auditApi, type AuditEventsParams } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface AuditExportButtonProps {
  /** Filtros activos, sin paginación: el CSV baja todo lo que coincide. */
  params: AuditEventsParams;
  /** La descarga terminó; la página pone el aviso. */
  onDone: () => void;
  /** Fallo de red o del servidor, ya traducido. */
  onError: (message: string) => void;
}

/**
 * Descarga del listado filtrado en CSV. El archivo lo arma el servidor (con el
 * diff antes/después ya en texto) para que lo descargado coincida con lo que se
 * ve en pantalla; aquí solo se guarda el `Blob` con un enlace temporal, como en
 * el resto de descargas de la aplicación.
 */
export const AuditExportButton = ({ params, onDone, onError }: AuditExportButtonProps) => {
  const [exportando, setExportando] = useState(false);

  const descargar = async (): Promise<void> => {
    // El botón ya se bloquea con `loading`, pero un doble clic rápido no debe
    // lanzar dos exportaciones (la segunda pediría el mismo CSV otra vez).
    if (exportando) return;

    setExportando(true);
    try {
      const blob = await auditApi.exportCsv(params);
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = exportFileName(params);
      document.body.append(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
      onDone();
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setExportando(false);
    }
  };

  return (
    <Button
      variant="secondary"
      loading={exportando}
      loadingLabel={t('auditoria.exportando')}
      onClick={() => void descargar()}
      leadingIcon={<Download className="size-4" aria-hidden="true" />}
    >
      {t('auditoria.exportar')}
    </Button>
  );
};
