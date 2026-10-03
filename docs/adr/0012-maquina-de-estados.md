# ADR 0012 — Máquina de estados de cita, historia clínica y sesión

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Varios módulos cambian el estado de un paciente (programación, secretaría, consultorio) y otros
lo consultan (pantallas, reportes, auditoría). Sin una definición única, cada módulo inventaría
sus propios estados y las reglas de negocio quedarían repartidas.

## Decisión

Una **única máquina de estados** definida en `packages/contracts/src/domain/state-machine.ts`
como dato, no como código disperso:

```
Solicitud:  EN_ESPERA_CITA → PROGRAMADA → NOTIFICADA → EN_SALA_ESPERA
            → LLAMADO (1.º/2.º) → EN_CONSULTA → ATENDIDO
Salidas:    NO_ASISTIO · CANCELADA · REPROGRAMADA (enlaza un ticket nuevo)
Historia:   BORRADOR → FIRMADA (+ adendas, nunca sobrescritura)
Sesión:     BORRADOR → CERRADA (inmutable) (+ sesión de corrección enlazada)
```

Cada transición declara **qué roles** pueden ejecutarla y si **exige motivo**. Reglas duras:
`ATENDIDO` requiere sesión cerrada (o historia firmada en la primera visita), y `NO_ASISTIO`
solo después de la hora de la cita más 15 minutos de tolerancia.

## Consecuencias

- ✅ La interfaz, la API y las pruebas comparten las mismas reglas; hay pruebas dedicadas a la
  máquina de estados desde la Fase 0.
- ✅ Toda transición queda en `status_history` con actor y hora, lo que habilita los reportes de
  tiempos de espera.
- ⚠️ Cambiar la máquina exige actualizar contratos y pruebas en el mismo commit.
