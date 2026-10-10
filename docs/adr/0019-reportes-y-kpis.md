# ADR 0019 — Reportes y KPIs seleccionados

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El módulo de reportes debe permitir buscar por fecha, rango de edad editable, sexo y estado, y
mostrar pacientes atendidos, inasistencias y segmentación por condición de salud, con gráficas
para visualizar. Sin acotar el catálogo, la fase se vuelve infinita.

## Decisión

La Fase 9 entrega estos reportes:

| Reporte | Contenido |
| :--- | :--- |
| **Embudo y conversión** | Solicitudes → programadas → notificadas → atendidas, con tasa de inasistencia por semana y mes |
| **Ocupación de agenda** | Cupos usados frente a disponibles por día y detección de horas pico |
| **Demografía** | Pirámide de edad y distribución por sexo, con rango de edad editable |
| **Perfil clínico agregado** | Diabéticos, hipertensos, alérgicos, anticoagulados y embarazadas (pedido original del interesado) |
| **Salud bucal** | Prevalencia de caries, restauraciones y ausencias por pieza y por paciente (desde el odontograma) |
| **Recetas** | Medicamentos más recetados por período |
| **Exportación** | Cualquier reporte a CSV y PDF, listo para imprimir |

> **No incluido por ahora:** el reporte de productividad por odontólogo, porque el consultorio
> tiene un solo profesional ([ADR 0006](0006-un-odontologo-un-sillon.md)). Se añadirá cuando
> exista un segundo odontólogo.

Todos los reportes comparten filtros de **fecha, rango de edad, sexo y estado**, y se sirven
desde un **read model propio** alimentado por eventos (nunca consultando las bases operativas).

## Consecuencias

- ✅ Los reportes no compiten con la operación diaria: se leen de `odonto_reporting`.
- ✅ El catálogo es cerrado y verificable con el seed determinista del modo test.
- ⚠️ El read model debe poder reconstruirse desde cero (se documenta y se prueba con
  `seed:verify` en la Fase 10).
