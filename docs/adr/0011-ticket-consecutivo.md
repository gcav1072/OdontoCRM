# ADR 0011 — Ticket con secuencia global y prefijo alfabético al desbordar

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Cada solicitud de cita debe generar un ticket visible y dictable, en el rango `#000000`–`#999999`.
Dos solicitudes simultáneas no pueden recibir el mismo número, y el número debe ser fácil de
leer por teléfono.

## Decisión

- El valor lo entrega una **secuencia de PostgreSQL** (`nextval`), que es atómico: dos
  solicitudes concurrentes nunca colisionan.
- Se muestra con **seis dígitos y almohadilla**: `#000001` … `#999999`.
- Al superar 999.999, el ticket salta a **`A-000001`**, luego `B-000001`, … y `AA-000001` si
  algún día hiciera falta (lógica en `packages/contracts/src/domain/ticket.ts`, con pruebas).
- `parseTicket` acepta lo que el paciente escribe (`000123`, `#000123`, `a-000001`) para poder
  consultar el estado por el bot.

## Consecuencias

- ✅ Único bajo concurrencia y cómodo de dictar; el prefijo solo aparece si se agota el ciclo.
- ✅ El formato vive en los contratos: interfaz, bot, `.ics` y pruebas usan la misma función.
- ⚠️ Reiniciar la secuencia nunca debe hacerse a mano en producción (dejaría de ser única en el
  tiempo); si se necesita, se documenta como operación de mantenimiento.
