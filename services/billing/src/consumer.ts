import type { DomainEvent } from '@odontocrm/events';
import { EVENT_TOPICS } from '@odontocrm/events';
import { z } from 'zod';

import { createDraftFromSession, type DraftOutcome } from './billing/invoice-service.js';
import type { BillingDb } from './db/client.js';
import type { BillingPatientLookup } from './shared/patient-client.js';

/**
 * Consumidor de eventos del servicio de facturación.
 *
 * Su único trabajo en esta fase: **reaccionar al cierre de una sesión clínica** creando un borrador de
 * factura. Nunca bloquea la salida del consultorio (es asíncrono) y es idempotente por `eventId` y por
 * sesión ([ADR 0044](../../../../docs/adr/0044-modulo-de-facturacion-desacoplado.md)).
 *
 * El sobre **no** valida la carga contra un esquema estricto, así que aquí se lee con tolerancia: lo
 * que no encaje se ignora y se anota, en vez de tumbar el lote entero.
 */
const sessionClosedPayloadSchema = z.object({
  session: z.object({
    sessionId: z.uuid(),
    patientId: z.uuid(),
    /** Las partidas completas (B14). */
    procedures: z
      .array(
        z.object({
          code: z.string().min(1),
          detail: z.string().nullish(),
          toothNumber: z.number().int().nullish(),
          surfaces: z.array(z.string()).nullish(),
        }),
      )
      .nullish(),
    /** Antes de B14 el evento solo traía los códigos: se sigue aceptando (aditivo). */
    procedureCodes: z.array(z.string()).nullish(),
  }),
});

export interface BillingConsumerDeps {
  db: BillingDb;
  patientLookup: BillingPatientLookup;
}

export interface BillingConsumerOutcome {
  creados: number;
  duplicados: number;
  yaCobradas: number;
  ignorados: number;
}

const vacio = (): BillingConsumerOutcome => ({
  creados: 0,
  duplicados: 0,
  yaCobradas: 0,
  ignorados: 0,
});

const anotar = (resultado: BillingConsumerOutcome, salida: DraftOutcome): void => {
  if (salida === 'creado') resultado.creados += 1;
  else if (salida === 'duplicado') resultado.duplicados += 1;
  else resultado.yaCobradas += 1;
};

export const handleDomainEvents = async (
  deps: BillingConsumerDeps,
  events: readonly DomainEvent[],
): Promise<BillingConsumerOutcome> => {
  const resultado = vacio();

  for (const event of events) {
    if (event.eventType !== EVENT_TOPICS.sessionClosed) {
      resultado.ignorados += 1;
      continue;
    }

    const parsed = sessionClosedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      resultado.ignorados += 1;
      continue;
    }

    const sesion = parsed.data.session;
    const procedures =
      sesion.procedures?.map((procedimiento) => ({
        code: procedimiento.code,
        detail: procedimiento.detail ?? null,
        toothNumber: procedimiento.toothNumber ?? null,
        surfaces: procedimiento.surfaces ?? [],
      })) ??
      // Un evento anterior al cambio de contrato: sin pieza ni caras, pero la partida existe.
      (sesion.procedureCodes ?? []).map((code) => ({
        code,
        detail: null,
        toothNumber: null,
        surfaces: [],
      }));

    anotar(
      resultado,
      await createDraftFromSession(deps, {
        eventId: event.eventId,
        topic: event.eventType,
        sessionId: sesion.sessionId,
        patientId: sesion.patientId,
        procedures,
      }),
    );
  }

  return resultado;
};
