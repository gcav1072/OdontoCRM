import {
  formatTicket,
  type AppointmentSummary,
  type InboundMessage,
  type PatientSummary,
  type RequestSummary,
} from '@odontocrm/contracts';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdapterRegistry, type AdapterRegistry } from '../canales/adaptador.js';
import { createSimulatedAdapter, type SimulatedAdapter } from '../canales/simulado.js';
import { loadNotificationsConfig, type NotificationsConfig } from '../config.js';
import { createNotificationsDatabase } from '../db/client.js';
import { botConversations, patientChannels, processedUpdates } from '../db/schema.js';
import type { InternalClients } from '../internal-client.js';
import {
  createLinkCode,
  ensureDefaultTemplates,
  findChannel,
  linkChat,
  listChannels,
} from '../messaging.js';
import { handleInbound, loadConversation } from './asistente.js';

/**
 * Pruebas de integración de la **fase B de v1.2** contra PostgreSQL real:
 *
 *  - el alta empieza por la cédula (Paso 1) y corrige un solo campo o todo;
 *  - el cambio de fecha adulto ↔ menor pide o suelta el representante;
 *  - una CI existente exige verificación ligera de identidad (3 intentos);
 *  - «nueva» en un chat vinculado pregunta si la cita es para otra persona y la
 *    desvinculación afecta **solo** a ese chat;
 *  - «volver» / «salir» funcionan a mitad de cualquier paso;
 *  - la vinculación por código responde **una sola burbuja**.
 *
 * Sin `TEST_NOTIFICATIONS_DATABASE_URL` la suite se salta (como el resto de
 * integraciones): se ejecuta con `node tools/test-integration.mjs <ruta>`.
 */
const databaseUrl = process.env['TEST_NOTIFICATIONS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-6);
const MARK = `PRUEBA-F12-${suffix}`;

/** Paciente y solicitud de mentira: el flujo del asistente no toca otros servicios. */
const fakeClients = (): InternalClients & {
  requests: RequestSummary[];
  citas: AppointmentSummary[];
} => {
  const requests: RequestSummary[] = [];
  const citas: AppointmentSummary[] = [];
  return {
    requests,
    citas,
    upsertPatient: async (input) => ({
      created: true,
      patient: {
        id: globalThis.crypto.randomUUID(),
        fullName: input.fullName,
        document: `${input.docType}-${input.docNumber}`,
      },
    }),
    findPatientByDocument: async () => null,
    createRequest: async (input) => {
      const summary: RequestSummary = {
        id: globalThis.crypto.randomUUID(),
        ticket: formatTicket(1000 + requests.length).value,
        ticketNumber: 1000 + requests.length,
        channel: input.channel,
        patientId: input.patientId,
        patientName: input.patientName,
        patientDocument: input.patientDocument ?? null,
        patientPhone: input.patientPhone ?? null,
        reason: input.reason,
        status: 'en_espera_cita',
        priority: 0,
        requestedAt: new Date().toISOString(),
        notes: null,
        waitingDays: 0,
        appointmentId: null,
        appointmentDate: null,
        appointmentTime: null,
        createdAt: new Date().toISOString(),
      };
      requests.push(summary);
      return summary;
    },
    findRequestByTicket: async (ticket) =>
      requests.find((request) => request.ticket === ticket) ?? null,
    updateRequestReason: async (id, reason) => {
      const found = requests.find((request) => request.id === id);
      if (found === undefined) throw new Error('no existe');
      found.reason = reason;
      return found;
    },
    cancelRequest: async (id) => {
      const found = requests.find((request) => request.id === id);
      if (found === undefined) throw new Error('no existe');
      found.status = 'cancelada';
      return found;
    },
    getAppointment: async () => null,
    listPatientSummaries: async () => [],
    listAppointments: async (filters) => {
      const items = citas
        .filter((cita) => filters.patientId === undefined || cita.patientId === filters.patientId)
        .filter((cita) => filters.from === undefined || cita.date >= filters.from)
        .filter((cita) => filters.to === undefined || cita.date <= filters.to)
        .filter((cita) => filters.status === undefined || cita.status === filters.status)
        .filter(
          (cita) =>
            filters.confirmed === undefined || (cita.confirmedAt !== null) === filters.confirmed,
        );
      return {
        items,
        total: items.length,
        page: 1,
        pageSize: filters.pageSize ?? 25,
        totalPages: 1,
      };
    },
    confirmAppointment: async (id, input) => {
      const encontrada = citas.find((cita) => cita.id === id);
      if (encontrada === undefined) throw new Error('la cita no existe');
      encontrada.status = 'confirmada';
      encontrada.confirmedAt = new Date().toISOString();
      encontrada.confirmedChannel = input.channel;
      return encontrada;
    },
    cancelAppointment: async (id, input) => {
      const encontrada = citas.find((cita) => cita.id === id);
      if (encontrada === undefined) throw new Error('la cita no existe');
      encontrada.status = 'cancelada';
      encontrada.cancelledAt = new Date().toISOString();
      encontrada.cancelledChannel = input.channel;
      return encontrada;
    },
    listRequestsByPatient: async (patientId) =>
      requests.filter((request) => request.patientId === patientId),
    getPrescriptionMeta: async () => null,
    downloadPrescriptionPdf: async () => {
      throw new Error('el doble no tiene récipes archivados');
    },
    getInvoiceMeta: async () => null,
    downloadInvoicePdf: async () => {
      throw new Error('el doble no tiene facturas archivadas');
    },
    getPaymentMeta: async () => null,
    downloadReceiptPdf: async () => {
      throw new Error('el doble no tiene recibos archivados');
    },
  };
};

/** Paciente de mentira: lo mínimo que necesita la verificación y el vínculo. */
const unPaciente = (id: string, overrides: Partial<PatientSummary> = {}): PatientSummary => ({
  id,
  docType: 'V',
  docNumber: '12345678',
  document: 'V-12345678',
  fullName: 'María Pérez',
  birthDate: '1990-05-15',
  age: 35,
  isMinor: false,
  sex: 'F',
  phone: '+584121234567',
  phoneAlt: null,
  status: 'activo',
  isFictitious: false,
  hasGuardian: false,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describeWithDatabase(
  'asistente v1.2: CI primero, corrección, identidad y cambio de paciente',
  () => {
    let handle: Awaited<ReturnType<typeof createNotificationsDatabase>>;
    let config: NotificationsConfig;
    let clients: ReturnType<typeof fakeClients>;

    let telegram: SimulatedAdapter;
    let whatsapp: SimulatedAdapter;
    let registry: AdapterRegistry;
    let services: Parameters<typeof handleInbound>[0];

    const direccionBase = `8${suffix}`;
    let contador = 0;

    /** Entrega un mensaje al núcleo como lo haría el canal. */
    const enviar = async (
      adapter: SimulatedAdapter,
      entrada: { direccion: string; texto?: string; accion?: string },
    ): Promise<{ handled: boolean; action?: string }> => {
      contador += 1;
      const inbound: InboundMessage = {
        canal: adapter.id,
        direccion: entrada.direccion,
        usuario: 'paciente-de-prueba',
        texto: entrada.texto ?? null,
        accion: entrada.accion ?? null,
        eventoId: `f12-${suffix}-${String(contador)}`,
        recibidoEn: new Date().toISOString(),
      };
      return handleInbound(services, inbound);
    };

    /** Burbujas enviadas a una dirección concreta (para contar mensajes). */
    const enviadosA = (adapter: SimulatedAdapter, direccion: string) =>
      adapter.sent.filter((mensaje) => mensaje.direccion === direccion);

    /** Recorre el alta completa hasta el resumen de confirmación. */
    const recorrerAlta = async (
      adapter: SimulatedAdapter,
      direccion: string,
      datos: {
        doc: string;
        nombre: string;
        telefono: string;
        nacimiento: string;
        sexo: 'M' | 'F' | 'O';
        motivo: string;
        representante?: string;
      },
    ): Promise<void> => {
      await enviar(adapter, { direccion, texto: 'cita' });
      await enviar(adapter, { direccion, accion: 'doc:V' });
      await enviar(adapter, { direccion, texto: datos.doc });
      await enviar(adapter, { direccion, texto: datos.nombre });
      await enviar(adapter, { direccion, texto: datos.telefono });
      await enviar(adapter, { direccion, texto: datos.nacimiento });
      if (datos.representante !== undefined) {
        await enviar(adapter, { direccion, texto: datos.representante });
      }
      await enviar(adapter, { direccion, accion: `sexo:${datos.sexo}` });
      await enviar(adapter, { direccion, texto: datos.motivo });
    };

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error('falta TEST_NOTIFICATIONS_DATABASE_URL');

      config = loadNotificationsConfig({
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: 'silent',
        TELEGRAM_MODE: 'simulado',
        CLINIC_NAME: 'Consultorio de prueba',
        CLINIC_ADDRESS: 'Calle de prueba 123',
        // Estos recorridos encadenan más de 10 mensajes por chat a propósito (corregir
        // un campo, volver atrás, desvincular y volver a registrar); el anti-flood
        // tiene su propia prueba en la suite general.
        ANTI_FLOOD_MAX_MESSAGES: '100',
      });
      handle = createNotificationsDatabase(config);
      await ensureDefaultTemplates(handle.db);

      telegram = createSimulatedAdapter('telegram');
      whatsapp = createSimulatedAdapter('whatsapp', { botones: false });
      registry = createAdapterRegistry([telegram, whatsapp]);

      clients = fakeClients();
      services = { config, db: handle.db, canales: registry, clients };

      await registry.start(async (entrante) => {
        await handleInbound(services, entrante);
      });
    }, 30_000);

    afterAll(async () => {
      if (!ready) return;
      await handle.db
        .delete(patientChannels)
        .where(like(patientChannels.direccion, `${direccionBase}%`));
      await handle.db
        .delete(botConversations)
        .where(like(botConversations.direccion, `${direccionBase}%`));
      await handle.db
        .delete(processedUpdates)
        .where(like(processedUpdates.direccion, `${direccionBase}%`));
      await registry.stop();
      await handle.close();
    });

    it('corregir un solo campo vuelve al resumen y «corregir todo» reinicia en el documento', async () => {
      const direccion = `${direccionBase}1`;
      await recorrerAlta(telegram, direccion, {
        doc: '11111111',
        nombre: 'Ana Gómez',
        telefono: '0414-1111111',
        nacimiento: '15/05/1990',
        sexo: 'F',
        motivo: `Dolor en la muela ${MARK}`,
      });

      let conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('confirmacion');
      expect(conversation.draft['editingSingleField']).toBe(false);

      // «Corregir» ya no reinicia el alta: abre el menú granular en un solo salto.
      await enviar(telegram, { direccion, accion: 'confirmar:no' });
      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('corregir_menu');
      expect(telegram.sent.at(-1)?.botones).toContain('Teléfono');

      // Un solo campo: se actualiza y se vuelve directo al resumen.
      await enviar(telegram, { direccion, accion: 'corregir:telefono' });
      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('telefono');
      expect(conversation.draft['editingSingleField']).toBe(true);

      await enviar(telegram, { direccion, texto: '0414-2222222' });
      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('confirmacion');
      expect(conversation.draft['editingSingleField']).toBe(false);
      expect(conversation.draft['phone']).toBe('+584142222222');
      // El resumen vuelve a salir en la misma burbuja que el paso del campo.
      expect(telegram.sent.at(-1)?.texto).toContain('+584142222222');

      // «Corregir todo» sí empieza de cero, por el Paso 1 (documento).
      await enviar(telegram, { direccion, accion: 'confirmar:no' });
      await enviar(telegram, { direccion, accion: 'corregir:todo' });
      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('documento');
      expect(conversation.patientId).toBeNull();
      expect(conversation.draft['flow']).toBe('nueva');
      expect(conversation.draft['editingSingleField']).toBe(false);
      expect(telegram.sent.at(-1)?.texto).toContain('Paso 1 de 7');
    }, 60_000);

    it('cambiar la fecha de nacimiento entre adulto y menor pide o suelta el representante', async () => {
      const direccion = `${direccionBase}2`;
      await recorrerAlta(telegram, direccion, {
        doc: '22222222',
        nombre: 'Pedro Rojas',
        telefono: '0414-2222222',
        nacimiento: '15/05/1990',
        sexo: 'M',
        motivo: `Limpieza ${MARK}`,
      });

      // De adulto a menor sin representante: se pide el representante sin perder la edición.
      await enviar(telegram, { direccion, accion: 'confirmar:no' });
      await enviar(telegram, { direccion, accion: 'corregir:nacimiento' });
      await enviar(telegram, { direccion, texto: '10/10/2015' });
      let conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('representante');
      expect(conversation.draft['editingSingleField']).toBe(true);
      expect(telegram.sent.at(-1)?.texto).toContain('menor de edad');

      await enviar(telegram, { direccion, texto: 'Laura Rojas' });
      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('confirmacion');
      expect(conversation.draft['editingSingleField']).toBe(false);
      expect(conversation.draft['guardianName']).toBe('Laura Rojas');
      expect(telegram.sent.at(-1)?.texto).toContain('Representante: Laura Rojas');

      // De menor a adulto: se limpia el representante y se vuelve al resumen.
      await enviar(telegram, { direccion, accion: 'confirmar:no' });
      await enviar(telegram, { direccion, accion: 'corregir:nacimiento' });
      await enviar(telegram, { direccion, texto: '15/05/1990' });
      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('confirmacion');
      expect(conversation.draft['guardianName']).toBeNull();
      expect(telegram.sent.at(-1)?.texto).not.toContain('Representante:');
    }, 60_000);

    it('una CI existente pide verificación de identidad y vincula el chat al acertar', async () => {
      const patientId = globalThis.crypto.randomUUID();
      const direccion = `${direccionBase}3`;
      const originalFind = clients.findPatientByDocument;
      const originalSummaries = clients.listPatientSummaries;
      clients.findPatientByDocument = async () => ({
        id: patientId,
        fullName: 'María Pérez',
        docType: 'V',
        docNumber: '87654321',
        document: 'V-87654321',
        phone: '+584121234567',
        birthDate: '1990-05-15',
        sex: 'F',
      });
      clients.listPatientSummaries = async (ids) =>
        ids.includes(patientId)
          ? [
              unPaciente(patientId, {
                docNumber: '87654321',
                document: 'V-87654321',
                fullName: 'María Pérez',
              }),
            ]
          : [];

      try {
        await enviar(telegram, { direccion, texto: 'cita' });
        await enviar(telegram, { direccion, accion: 'doc:V' });
        await enviar(telegram, { direccion, texto: '87654321' });

        // El chat no está vinculado a esa ficha: se pide la prueba de identidad con el
        // nombre abreviado y el documento enmascarado.
        let conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.state).toBe('verificar_identidad');
        expect(conversation.patientId).toBe(patientId);
        expect(conversation.draft['verifyAttempts']).toBe(0);
        const verificacion = telegram.sent.at(-1)?.texto ?? '';
        expect(verificacion).toContain('María P.');
        expect(verificacion).toContain('V-•••••321');

        await enviar(telegram, { direccion, texto: '15/05/1990' });
        conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.state).toBe('motivo');
        expect(conversation.patientId).toBe(patientId);
        expect(conversation.draft['fullName']).toBe('María Pérez');

        // El chat quedó vinculado a la ficha verificada y sigue el alta en el Paso 6.
        const canal = await findChannel(handle.db, patientId);
        expect(canal).toMatchObject({ canal: 'telegram', direccion });

        await enviar(telegram, { direccion, texto: `Control de rutina ${MARK}` });
        await enviar(telegram, { direccion, accion: 'confirmar:si' });
        const created = clients.requests.at(-1);
        expect(created?.patientId).toBe(patientId);
        expect(created?.reason).toContain('Control de rutina');
      } finally {
        clients.findPatientByDocument = originalFind;
        clients.listPatientSummaries = originalSummaries;
      }
    }, 60_000);

    it('a los 3 intentos fallidos la verificación se agota y no vincula el chat', async () => {
      const patientId = globalThis.crypto.randomUUID();
      const direccion = `${direccionBase}4`;
      const originalFind = clients.findPatientByDocument;
      const originalSummaries = clients.listPatientSummaries;
      clients.findPatientByDocument = async () => ({
        id: patientId,
        fullName: 'María Pérez',
        docType: 'V',
        docNumber: '87654321',
        document: 'V-87654321',
        phone: '+584121234567',
        birthDate: '1990-05-15',
        sex: 'F',
      });
      clients.listPatientSummaries = async (ids) =>
        ids.includes(patientId)
          ? [
              unPaciente(patientId, {
                docNumber: '87654321',
                document: 'V-87654321',
                fullName: 'María Pérez',
              }),
            ]
          : [];

      try {
        await enviar(telegram, { direccion, texto: 'cita' });
        await enviar(telegram, { direccion, accion: 'doc:V' });
        await enviar(telegram, { direccion, texto: '87654321' });

        // Primer y segundo fallo: se avisa de los intentos que quedan.
        await enviar(telegram, { direccion, texto: '01/01/2000' });
        let conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.state).toBe('verificar_identidad');
        expect(conversation.draft['verifyAttempts']).toBe(1);
        expect(telegram.sent.at(-1)?.texto).toContain('2 intento');

        await enviar(telegram, { direccion, texto: '02/02/2001' });
        conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.draft['verifyAttempts']).toBe(2);
        expect(telegram.sent.at(-1)?.texto).toContain('1 intento');

        // Tercer fallo: se suelta al candidato y no se vincula nada.
        await enviar(telegram, { direccion, texto: '03/03/2002' });
        conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.state).toBe('inicio');
        expect(conversation.patientId).toBeNull();
        expect(conversation.draft['verifyAttempts']).toBe(0);
        expect(telegram.sent.at(-1)?.texto).toContain('no pude verificar');
        expect(await findChannel(handle.db, patientId)).toBeNull();
      } finally {
        clients.findPatientByDocument = originalFind;
        clients.listPatientSummaries = originalSummaries;
      }
    }, 60_000);

    it('«nueva» en un chat vinculado a otra persona desvincula solo ese chat y registra al nuevo', async () => {
      const pacienteA = globalThis.crypto.randomUUID();
      const direccionA = `${direccionBase}5`;
      const direccionB = `${direccionBase}5b`;
      const originalSummaries = clients.listPatientSummaries;
      // El paciente A tiene dos chats: el de WhatsApp (donde ocurre esto) y su Telegram.
      clients.listPatientSummaries = async (ids) =>
        ids.includes(pacienteA) ? [unPaciente(pacienteA, { fullName: 'María Pérez' })] : [];
      await linkChat(handle.db, { patientId: pacienteA, canal: 'whatsapp', direccion: direccionA });
      await linkChat(handle.db, { patientId: pacienteA, canal: 'telegram', direccion: direccionB });

      try {
        // 1) «cita» en el chat vinculado: pregunta para quién es, en una sola burbuja.
        await enviar(whatsapp, { direccion: direccionA, texto: 'cita' });
        const pregunta = whatsapp.sent.at(-1)?.texto ?? '';
        expect(pregunta).toContain('vinculado a María Pérez');
        expect(pregunta).toContain('1) Para mí');
        expect(pregunta).toContain('2) Para otra persona');

        // 2) «Para otra persona»: explica la regla y pide confirmar la desvinculación.
        await enviar(whatsapp, { direccion: direccionA, texto: '2' });
        let conversation = await loadConversation(handle.db, 'whatsapp', direccionA, null);
        expect(conversation.state).toBe('confirmar_desvinculacion');
        expect(conversation.draft['pendingUnlink']).toBe('desvincular_y_nueva');
        expect(whatsapp.sent.at(-1)?.texto).toContain('solo puede estar vinculado a un paciente');

        // 3) «Sí»: desvincula y pide el Paso 1 en la MISMA burbuja.
        const antes = enviadosA(whatsapp, direccionA).length;
        await enviar(whatsapp, { direccion: direccionA, texto: '1' });
        const burbujas = enviadosA(whatsapp, direccionA);
        expect(burbujas.length - antes).toBe(1);
        expect(burbujas.at(-1)?.texto).toContain('quedó desvinculado');
        expect(burbujas.at(-1)?.texto).toContain('Paso 1 de 7');
        conversation = await loadConversation(handle.db, 'whatsapp', direccionA, null);
        expect(conversation.state).toBe('documento');
        expect(conversation.patientId).toBeNull();
        expect(conversation.draft['flow']).toBe('nueva');

        // El **otro** chat del paciente A (su Telegram) sigue vinculado.
        const canalesA = await listChannels(handle.db, pacienteA);
        expect(canalesA).toHaveLength(1);
        expect(canalesA[0]).toMatchObject({ canal: 'telegram', direccion: direccionB });

        // 4) El chat desvinculado registra al nuevo paciente (menor, con representante).
        await enviar(whatsapp, { direccion: direccionA, accion: 'doc:V' });
        await enviar(whatsapp, { direccion: direccionA, texto: '22222222' });
        await enviar(whatsapp, { direccion: direccionA, texto: 'Luis Pérez' });
        await enviar(whatsapp, { direccion: direccionA, texto: '0414-3333333' });
        await enviar(whatsapp, { direccion: direccionA, texto: '10/10/2010' });
        await enviar(whatsapp, { direccion: direccionA, texto: 'Carmen Pérez' });
        await enviar(whatsapp, { direccion: direccionA, accion: 'sexo:M' });
        await enviar(whatsapp, { direccion: direccionA, texto: `Control del niño ${MARK}` });
        await enviar(whatsapp, { direccion: direccionA, accion: 'confirmar:si' });

        const created = clients.requests.at(-1);
        expect(created?.patientName).toBe('Luis Pérez');
        const canalNuevo = await findChannel(handle.db, created?.patientId ?? '');
        expect(canalNuevo).toMatchObject({ canal: 'whatsapp', direccion: direccionA });

        // Y el chat del paciente A no se tocó al registrar a B.
        const canalesDespues = await listChannels(handle.db, pacienteA);
        expect(canalesDespues).toHaveLength(1);
        expect(canalesDespues[0]).toMatchObject({ canal: 'telegram', direccion: direccionB });
      } finally {
        clients.listPatientSummaries = originalSummaries;
      }
    }, 60_000);

    it('«volver» retrocede conservando el borrador y «salir» cancela el proceso', async () => {
      const direccion = `${direccionBase}6`;
      await enviar(telegram, { direccion, texto: 'cita' });
      await enviar(telegram, { direccion, accion: 'doc:V' });
      await enviar(telegram, { direccion, texto: '33333333' });
      await enviar(telegram, { direccion, texto: 'Ana Ruiz' });

      // En el teléfono, «volver» regresa al nombre sin perder lo escrito.
      await enviar(telegram, { direccion, texto: 'volver' });
      let conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('nombre');
      expect(conversation.draft['fullName']).toBe('Ana Ruiz');
      expect(telegram.sent.at(-1)?.texto).toContain('Paso 2 de 7');

      await enviar(telegram, { direccion, texto: 'Ana Ruiz Gómez' });
      await enviar(telegram, { direccion, texto: '0414-4444444' });

      // En el nacimiento, «volver» regresa al teléfono.
      await enviar(telegram, { direccion, texto: 'volver' });
      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('telefono');
      expect(conversation.draft['phone']).toBe('+584144444444');

      await enviar(telegram, { direccion, texto: '0414-5555555' });
      await enviar(telegram, { direccion, texto: '15/05/1990' });
      await enviar(telegram, { direccion, accion: 'sexo:F' });
      await enviar(telegram, { direccion, texto: `Motivo ${MARK}` });
      await enviar(telegram, { direccion, texto: 'salir' });

      conversation = await loadConversation(handle.db, 'telegram', direccion, null);
      expect(conversation.state).toBe('inicio');
      expect(conversation.patientId).toBeNull();
      expect(conversation.draft['fullName']).toBeNull();
      expect(telegram.sent.at(-1)?.texto).toContain('Proceso cancelado');
    }, 60_000);

    it('«salir» en un chat vinculado limpia el borrador pero conserva la ficha', async () => {
      const paciente = globalThis.crypto.randomUUID();
      const direccion = `${direccionBase}6b`;
      const originalSummaries = clients.listPatientSummaries;
      clients.listPatientSummaries = async (ids) =>
        ids.includes(paciente) ? [unPaciente(paciente, { fullName: 'María Pérez' })] : [];
      await linkChat(handle.db, { patientId: paciente, canal: 'telegram', direccion });

      try {
        await enviar(telegram, { direccion, texto: 'cita' });
        await enviar(telegram, { direccion, accion: 'cita_para:yo' });
        let conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.state).toBe('motivo');

        await enviar(telegram, { direccion, texto: 'salir' });
        conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.state).toBe('inicio');
        expect(conversation.patientId).toBe(paciente);
        expect(telegram.sent.at(-1)?.texto).toContain('Proceso cancelado');
        expect(await findChannel(handle.db, paciente)).toMatchObject({
          canal: 'telegram',
          direccion,
        });
      } finally {
        clients.listPatientSummaries = originalSummaries;
      }
    }, 60_000);

    it('la vinculación por código responde una sola burbuja con el nombre del paciente', async () => {
      const patientId = globalThis.crypto.randomUUID();
      const direccion = `${direccionBase}7`;
      const code = `V12${suffix}`;
      const originalSummaries = clients.listPatientSummaries;
      clients.listPatientSummaries = async (ids) =>
        ids.includes(patientId) ? [unPaciente(patientId, { fullName: 'María Pérez' })] : [];
      await createLinkCode(handle.db, {
        patientId,
        code,
        expiresAt: new Date(Date.now() + 60_000),
      });

      try {
        const resultado = await enviar(telegram, { direccion, texto: `/start ${code}` });
        expect(resultado.action).toBe('vinculado');

        // v1.2: solo UNA burbuja (plantilla `vinculado`), sin bienvenida + «Listo…».
        const burbujas = enviadosA(telegram, direccion);
        expect(burbujas).toHaveLength(1);
        expect(burbujas[0]?.texto).toContain('quedó vinculado');
        expect(burbujas[0]?.texto).toContain('María Pérez');

        const canal = await findChannel(handle.db, patientId);
        expect(canal).toMatchObject({ canal: 'telegram', direccion });
        const conversation = await loadConversation(handle.db, 'telegram', direccion, null);
        expect(conversation.patientId).toBe(patientId);
      } finally {
        clients.listPatientSummaries = originalSummaries;
      }
    }, 60_000);

    it('el menú rápido de bienvenida/ayuda despacha las acciones y permite desvincular', async () => {
      const direccion = `${direccionBase}8`;
      // 1) Bienvenida en un chat no vinculado: menú numerado sin «Cambiar de paciente».
      await enviar(whatsapp, { direccion, texto: 'hola' });
      const bienvenida = whatsapp.sent.at(-1)?.texto ?? '';
      expect(bienvenida).toContain('1) Pedir una cita');
      expect(bienvenida).toContain('4) Cancelar cita o solicitud');
      expect(bienvenida).not.toContain('5) Cambiar de paciente');

      // «1» vale como «Pedir una cita».
      await enviar(whatsapp, { direccion, texto: '1' });
      let conversation = await loadConversation(handle.db, 'whatsapp', direccion, null);
      expect(conversation.state).toBe('documento');
      expect(whatsapp.sent.at(-1)?.texto).toContain('Paso 1 de 7');

      // 2) Ayuda en un chat vinculado: incluye la pista de navegación y «Cambiar de paciente».
      const paciente = globalThis.crypto.randomUUID();
      const direccionVinculada = `${direccionBase}8b`;
      const originalSummaries = clients.listPatientSummaries;
      clients.listPatientSummaries = async (ids) =>
        ids.includes(paciente) ? [unPaciente(paciente, { fullName: 'María Pérez' })] : [];
      await linkChat(handle.db, {
        patientId: paciente,
        canal: 'whatsapp',
        direccion: direccionVinculada,
      });

      try {
        await enviar(whatsapp, { direccion: direccionVinculada, texto: 'ayuda' });
        const ayuda = whatsapp.sent.at(-1)?.texto ?? '';
        expect(ayuda).toContain('escribe «volver» para retroceder');
        expect(ayuda).toContain('5) Cambiar de paciente');

        // «5» abre la confirmación de desvinculación; «no» la cancela sin tocar el vínculo.
        await enviar(whatsapp, { direccion: direccionVinculada, texto: '5' });
        conversation = await loadConversation(handle.db, 'whatsapp', direccionVinculada, null);
        expect(conversation.state).toBe('confirmar_desvinculacion');
        expect(whatsapp.sent.at(-1)?.texto).toContain('María Pérez');

        await enviar(whatsapp, { direccion: direccionVinculada, texto: 'no' });
        conversation = await loadConversation(handle.db, 'whatsapp', direccionVinculada, null);
        expect(conversation.state).toBe('inicio');
        expect(conversation.patientId).toBe(paciente);
        expect(whatsapp.sent.at(-1)?.texto).toContain('No se cambió nada');
        expect(await findChannel(handle.db, paciente)).toMatchObject({
          canal: 'whatsapp',
          direccion: direccionVinculada,
        });

        // Y la intención «desvincular» confirmada sí desvincula este chat.
        await enviar(whatsapp, { direccion: direccionVinculada, texto: 'desvincular' });
        await enviar(whatsapp, { direccion: direccionVinculada, texto: 'si' });
        conversation = await loadConversation(handle.db, 'whatsapp', direccionVinculada, null);
        expect(conversation.state).toBe('inicio');
        expect(conversation.patientId).toBeNull();
        expect(whatsapp.sent.at(-1)?.texto).toContain('quedó desvinculado');
        expect(await findChannel(handle.db, paciente)).toBeNull();
      } finally {
        clients.listPatientSummaries = originalSummaries;
      }
    }, 60_000);
  },
);
