/**
 * Tope de espera de las suites de integración.
 *
 * Las suites que comprueban el camino **outbox → cola → consumidor** (la auditoría
 * de identity, por ejemplo) esperan a que el efecto aparezca: no hay forma de
 * saber cuándo terminó, solo de mirar. El tope estaba escrito a mano en cada suite
 * (15 s) y, con cuatro suites en paralelo sobre una máquina cargada, a veces no
 * alcanzaba: fallaba una prueba distinta en cada corrida (medido el 2026-10-04 en
 * la PC Fedora de pruebas, con la pila de desarrollo levantada).
 *
 * Ahora es un solo número, con margen y ajustable por entorno:
 *
 *     TEST_WAIT_MS=60000 npm run test:integration
 *
 * El mínimo es 5 s (un valor menor es casi siempre un error de tecleo y haría
 * fallar las pruebas por impaciencia, no por un fallo real).
 */
const MINIMO_MS = 5_000;

const delEntorno = (): number => {
  const valor = Number(process.env['TEST_WAIT_MS'] ?? '');
  return Number.isFinite(valor) && valor >= MINIMO_MS ? valor : 30_000;
};

export const TEST_WAIT_MS = delEntorno();

/**
 * Lo que se midió el 2026-10-04 en la PC de pruebas: subir el tope **no** arregla
 * el fallo, porque no es lentitud sino un atasco intermitente del camino de la cola
 * cuando varias suites lo usan a la vez. Con el cambio de `packages/db` revertido en
 * un árbol aparte, las mismas pruebas fallan igual (2 de 3 corridas): es una
 * intermitencia **previa** a la Fase 10, no un efecto de sus cambios. Queda anotada
 * como hallazgo (P-28) para el endurecimiento: la suite se corre en verde con
 * `--solo` o con la máquina libre, y el tope se puede subir por entorno.
 */
export const ESPERA_NOTA = 'ver docs/PLAN_MAESTRO_FASES.md, hallazgo P-28';
