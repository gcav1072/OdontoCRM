/**
 * Reglas de las alertas del tablero (`npm run estado -- --alertas`).
 *
 * Viven aparte del tablero por una razón práctica: son la parte que tiene que
 * seguir siendo correcta cuando alguien toque la presentación, y aquí se pueden
 * probar sin base de datos ni pila (`alertas.test.mjs`). La función es **pura**:
 * recibe la foto que tomó el tablero y un instante, y devuelve la lista de
 * problemas en texto.
 *
 * El silencio es la señal de que todo va bien: un temporizador de `systemd` que no
 * imprime nada y sale con 0 no genera ruido; si algo falla, el servicio queda en
 * `failed` y el texto dice **qué** y **desde cuándo**.
 */

/** Umbrales, ajustables por entorno. */
export const LIMITES = {
  /** Outbox sin publicar: por encima de esto, el publicador no está corriendo. */
  outboxMinutos: Number(process.env.ESTADO_OUTBOX_MINUTOS ?? '5'),
  /** Cola con trabajos pendientes más viejos que esto. */
  colaMinutos: Number(process.env.ESTADO_COLA_MINUTOS ?? '10'),
  /** Envío en cola cuyo siguiente intento venció hace más de esto. */
  envioMinutos: Number(process.env.ESTADO_ENVIO_MINUTOS ?? '15'),
  /** Espacio libre mínimo en el disco del almacén (%). */
  discoLibre: Number(process.env.ESTADO_DISCO_LIBRE ?? '10'),
};

/** «hace 12 min» a partir de un instante ISO. */
export const hace = (instante, ahora = new Date()) => {
  const segundos = Math.round((ahora.getTime() - new Date(instante).getTime()) / 1000);
  if (segundos < 60) return `hace ${String(Math.max(0, segundos))} s`;
  if (segundos < 3600) return `hace ${String(Math.round(segundos / 60))} min`;
  if (segundos < 86_400) return `hace ${String(Math.round(segundos / 3600))} h`;
  return `hace ${String(Math.round(segundos / 86_400))} d`;
};

/** Tamaño legible. */
export const bytes = (valor) => {
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let numero = Number(valor);
  let indice = 0;
  while (numero >= 1024 && indice < unidades.length - 1) {
    numero /= 1024;
    indice += 1;
  }
  return `${numero.toFixed(numero < 10 && indice > 0 ? 1 : 0)} ${unidades[indice]}`;
};

const minutosDesde = (instante, ahora) => (ahora.getTime() - new Date(instante).getTime()) / 60_000;

/** Lista de problemas de una foto del sistema. Vacía = todo bien. */
export const alertasDe = (foto, ahora = new Date(), limites = LIMITES) => {
  // Si el tablero no pudo leer los entornos (corre sin sudo y son 0600 root:root),
  // la cola, el outbox y los envíos quedan «no comprobables»: eso NO es un problema
  // y no debe sonar como alarma. Se avisa una vez, en la pantalla del tablero.
  const sinPermisos = foto.permisos?.envLegible === false;
  const problemas = [];

  for (const servicio of foto.servicios ?? []) {
    if (!servicio.arriba) {
      problemas.push(
        `${servicio.name} (puerto ${String(servicio.port)}) no responde en /health` +
          (servicio.health?.error === undefined
            ? ` (HTTP ${String(servicio.health?.status)})`
            : `: ${servicio.health.error}`),
      );
    } else if (!servicio.listo) {
      const fallos = (servicio.fallos ?? []).map((check) => check.name).join(', ');
      problemas.push(
        `${servicio.name} responde pero no está listo (/ready HTTP ${String(servicio.ready?.status)}${fallos === '' ? '' : `: ${fallos}`})`,
      );
    }
  }

  // systemd: que quien escucha sea la unidad, no otra pila (banco de pruebas, Fase 10).
  if (foto.systemd?.disponible === true) {
    for (const unidad of foto.systemd.unidades ?? []) {
      const hayPuerto = unidad.pidPuerto !== null && unidad.pidPuerto !== undefined;
      if (unidad.activa !== 'active' && hayPuerto) {
        problemas.push(
          `el puerto de ${unidad.name} lo sirve el PID ${String(unidad.pidPuerto)} pero ${unidad.unidad} está ${String(unidad.activa)} (¿hay otra pila corriendo?)`,
        );
      } else if (unidad.activa === 'active' && hayPuerto && unidad.sirveLaUnidad === false) {
        problemas.push(
          `el puerto de ${unidad.name} lo sirve el PID ${String(unidad.pidPuerto)}, no ${unidad.unidad} (PID ${String(unidad.pidUnidad ?? '—')})`,
        );
      } else if (unidad.activa === 'failed') {
        problemas.push(`${unidad.unidad} está en failed: journalctl -u ${unidad.unidad} -n 50`);
      }
    }
  }

  if (foto.bases?.error !== undefined) {
    problemas.push(`base de datos: ${String(foto.bases.error)}`);
  }

  if (!sinPermisos && foto.cola?.error !== undefined) {
    problemas.push(`cola de eventos: ${String(foto.cola.error)}`);
  } else {
    for (const cola of foto.cola?.colas ?? []) {
      if (cola.fallidos > 0) {
        problemas.push(`cola ${cola.name}: ${String(cola.fallidos)} trabajo(s) fallido(s)`);
      }
      if (cola.pendientes > 0 && cola.masAntiguo !== null) {
        if (minutosDesde(cola.masAntiguo, ahora) > limites.colaMinutos) {
          problemas.push(
            `cola ${cola.name}: ${String(cola.pendientes)} pendiente(s), el más antiguo ${hace(cola.masAntiguo, ahora)}`,
          );
        }
      }
    }
  }

  for (const outbox of sinPermisos ? [] : (foto.outbox ?? [])) {
    if (outbox.error !== undefined) {
      problemas.push(`outbox de ${outbox.name}: ${String(outbox.error)}`);
      continue;
    }
    if (outbox.pendientes > 0 && outbox.masAntiguo !== null) {
      if (minutosDesde(outbox.masAntiguo, ahora) > limites.outboxMinutos) {
        problemas.push(
          `outbox de ${outbox.name}: ${String(outbox.pendientes)} sin publicar desde ${hace(outbox.masAntiguo, ahora)}` +
            (outbox.ultimoError === null || outbox.ultimoError === undefined
              ? ''
              : ` (último error: ${String(outbox.ultimoError)})`),
        );
      }
    }
  }

  if (foto.envios?.error === undefined && foto.envios !== undefined) {
    if (foto.envios.fallidos > 0) {
      problemas.push(`envíos fallidos en notificaciones: ${String(foto.envios.fallidos)}`);
    }
    if (foto.envios.enCola > 0 && foto.envios.proximoIntento !== null) {
      if (minutosDesde(foto.envios.proximoIntento, ahora) > limites.envioMinutos) {
        problemas.push(
          `cola de envíos atascada: ${String(foto.envios.enCola)} mensaje(s) esperando desde ${hace(foto.envios.proximoIntento, ahora)}`,
        );
      }
    }
  }

  if (foto.reportes?.ultimoRefresco?.ok === false) {
    problemas.push(
      `el refresco del read model de reportes falló: ${String(foto.reportes.ultimoRefresco.error ?? 'sin detalle')}`,
    );
  }

  if (foto.disco?.porcentaje !== undefined && foto.disco.porcentaje < limites.discoLibre) {
    problemas.push(
      `queda ${String(foto.disco.porcentaje)} % de disco (${bytes(foto.disco.libre)} libres)`,
    );
  }

  return problemas;
};
