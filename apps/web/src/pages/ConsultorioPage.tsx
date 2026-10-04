import { Card, CardContent, CardHeader, CardTitle } from '@odontocrm/ui';
import { useSearchParams } from 'react-router-dom';

import { PatientWorkspace, type PatientTab } from '../components/clinical/PatientWorkspace';
import { PatientSearchList } from '../components/patients/PatientSearchList';
import { t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';

/** Selector de paciente: se busca y se entra a su historia clínica. */
const PatientPicker = ({ onSelect }: { onSelect: (patientId: string) => void }) => (
  <Card>
    <CardHeader>
      <CardTitle>{t('clinica.selector.titulo')}</CardTitle>
      <p className="text-sm text-ink-muted">{t('clinica.selector.texto')}</p>
    </CardHeader>
    <CardContent>
      <div className="max-w-lg">
        <PatientSearchList onSelect={(paciente) => onSelect(paciente.id)} />
      </div>
    </CardContent>
  </Card>
);

/**
 * `/consultorio`: la historia clínica, la sesión del día y el odontograma.
 *
 * Muestra el aviso obligatorio cuando el paciente no tiene historia («primera
 * visita»), el formulario por pasos con guardado de borrador y, ya firmada, el
 * bloqueo con adendas; la pestaña de **sesión** (Fase 7A) escribe la evolución de
 * la visita y el odontograma se marca dentro de ella. La escritura exige
 * `clinical:write`; leer e imprimir basta con `clinical:read` (la secretaría
 * imprime la historia y el odontograma).
 *
 * El área del paciente vive en `PatientWorkspace` (Fase 8) porque la página
 * unificada `/flujo` muestra exactamente el mismo expediente: el paciente se abre
 * de uno en uno, así que cambiar de paciente desmonta el área y la pestaña vuelve
 * a la de entrada.
 */
export const ConsultorioPage = () => {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const patientId = params.get('paciente');
  // La ficha del paciente enlaza directo a la pestaña del odontograma y la
  // secretaría, a la sesión.
  const vista = params.get('vista');
  const vistaInicial: PatientTab =
    vista === 'odontograma' ? 'odontograma' : vista === 'sesion' ? 'sesion' : 'historia';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">{t('modulo.consultorio.titulo')}</h1>
        <p className="text-sm text-ink-muted">{t('modulo.consultorio.descripcion')}</p>
      </div>

      {patientId === null ? (
        <PatientPicker onSelect={(id) => setParams({ paciente: id })} />
      ) : (
        <PatientWorkspace
          patientId={patientId}
          puedeEscribir={hasPermission('clinical:write')}
          puedeVerOdontograma={hasPermission('odontogram:read')}
          puedeEditarOdontograma={hasPermission('odontogram:write')}
          initialTab={vistaInicial}
          onExit={() => setParams({})}
        />
      )}
    </div>
  );
};
