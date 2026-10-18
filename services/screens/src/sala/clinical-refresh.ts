import type { ConsultationState } from '@odontocrm/contracts';
import type { DomainEvent } from '@odontocrm/events';

import { CLINICAL_TOPICS, clinicalPatientId } from '../consumer.js';
import type { ScreensDb } from '../db/client.js';
import type { ChairCatalog, ClinicalAlertLookup } from '../internal-client.js';
import { consultationState, hasPatientOnConsultorioScreen } from './estado-service.js';

export interface ClinicalRefreshDeps {
  db: ScreensDb;
  alertLookup?: ClinicalAlertLookup | undefined;
  chairCatalog?: ChairCatalog | undefined;
}

/**
 * ¿El lote trae una historia clínica de un paciente que está **ahora** en la pantalla
 * del consultorio?
 *
 * Solo interesan los temas clínicos y solo si el paciente está `llamado` o
 * `en_consulta` en la sala; el resto de la historia (de un paciente que ya salió o de
 * uno que nunca entró) no cambia nada de lo que se ve.
 */
export const affectsConsultorio = async (
  db: ScreensDb,
  events: readonly DomainEvent[],
): Promise<boolean> => {
  const clinicos = events.filter((event) => CLINICAL_TOPICS.includes(event.eventType));
  if (clinicos.length === 0) return false;

  const pacientes = [
    ...new Set(
      clinicos
        .map((event) => clinicalPatientId(event))
        .filter((patientId): patientId is string => patientId !== null),
    ),
  ];
  return hasPatientOnConsultorioScreen(db, pacientes);
};

/**
 * Vuelve a repartir el estado del consultorio cuando la historia clínica del paciente
 * que se está viendo cambió.
 *
 * Devuelve `true` si publicó. El estado se arma **completo** y las alertas se piden en
 * vivo (`alertLookup`), así que la pantalla recibe la alergia recién escrita sin esperar
 * al respaldo periódico: el evento es el disparador, no el transporte del dato.
 */
export const refreshConsultorioIfNeeded = async (
  deps: ClinicalRefreshDeps,
  events: readonly DomainEvent[],
  publish: (estado: ConsultationState) => void,
): Promise<boolean> => {
  if (!(await affectsConsultorio(deps.db, events))) return false;

  publish(
    await consultationState(deps.db, {
      alertLookup: deps.alertLookup,
      chairCatalog: deps.chairCatalog,
    }),
  );
  return true;
};
