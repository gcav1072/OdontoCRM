import type { PatientSummary } from '@odontocrm/contracts';
import { Dialog } from '@odontocrm/ui';

import { t } from '../../lib/i18n';
import { PatientSearchList } from '../patients/PatientSearchList';

export interface PatientSearchDialogProps {
  open: boolean;
  onClose: () => void;
  /** El paciente elegido pasa al centro de la pantalla. */
  onSelect: (patient: PatientSummary) => void;
}

/**
 * Buscador de pacientes del atajo `F2` (y de su botón, para la tableta).
 *
 * Es el mismo buscador de `/consultorio` dentro de un diálogo: escribe el nombre,
 * el documento o el teléfono y al elegir el paciente queda abierto en el centro de
 * `/flujo`, sin salir de la jornada.
 */
export const PatientSearchDialog = ({ open, onClose, onSelect }: PatientSearchDialogProps) => (
  <Dialog
    open={open}
    onClose={onClose}
    title={t('clinica.selector.titulo')}
    description={t('flujo.buscar.texto')}
    size="md"
    closeLabel={t('comun.cerrar')}
  >
    <PatientSearchList
      autoFocus
      pageSize={8}
      emptyTitle={t('clinica.selector.vacio')}
      onSelect={(paciente) => {
        onClose();
        onSelect(paciente);
      }}
    />
  </Dialog>
);
