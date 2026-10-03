# ADR 0020 — Modo test con seed determinista y cédulas ficticias

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Se quiere poder arrancar el sistema con **pacientes ficticios**: unos en espera de cita y otros
ya atendidos en fechas anteriores al 2026-10-02, para probar y demostrar sin cargar datos a
mano y **sin riesgo de mezclarlos con pacientes reales**.

## Decisión

- **Seed determinista**: un generador pseudoaleatorio con semilla fija (`odontocrm-2026`,
  implementado en `packages/testing`) produce siempre los mismos pacientes, horas y tickets en
  cualquier máquina.
- **Ancla temporal**: el 2026-10-02. Las citas atendidas se reparten en los días previos.
- **Marcas inequívocas**: cédulas en el rango reservado **90.000.000+** y `is_fictitious = true`
  en cada registro; **banner rojo «MODO TEST»** fijo en la interfaz.
- **Comandos**: `npm run seed:test`, `npm run seed:reset` (borra **solo** lo ficticio, nunca
  toca datos reales) y `npm run seed:verify` (comprueba el determinismo con hashes).
- **Bloqueos**: con `NODE_ENV=production` o `ALLOW_TEST_MODE=false` el seed y el banner quedan
  deshabilitados, y mientras el modo test esté activo los envíos reales de Telegram se
  redirigen a un chat de prueba.

## Consecuencias

- ✅ Pruebas, demostraciones y capturas reproducibles.
- ✅ Imposible confundir un dato de prueba con uno real (rango de cédula + bandera + banner).
- ⚠️ El seed debe mantener el determinismo: cambiar la semilla o el algoritmo invalida las
  comparaciones históricas (queda advertido en el código).
