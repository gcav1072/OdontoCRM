# 0076 — Licencias vitalicias (sin vencimiento)

- **Fecha:** 2026-11-12 · **Estado:** propuesta (implementación en curso)

## Contexto

El [ADR 0075](0075-licenciamiento-offline-y-modo-consulta.md) definió el licenciamiento
offline con licencias **por tiempo** (mensual, trimestral y anual) y una prueba de 30
días. El mecanismo de revocación era «no renovar» y, al vencer, la instalación pasa a
modo consulta.

Se quiere vender también **licencias vitalicias** (pago único, sin vencimiento) desde el
mismo emisor. En offline una vitalicia no se renueva ni se revoca por vencimiento, así
que hay que decidir cómo se representa, cómo la interpreta el verificador y qué pasa
con los avisos y el modo consulta.

## Decisión

1. **Nuevo tipo `vitalicia`** en `LICENSE_KINDS`. Los tipos que sí vencen se separan en
   `LICENSE_KINDS_CON_DIAS` (mensual 30, trimestral 90, anual 365) y la duración se
   consulta con `diasDelTipoDeLicencia(tipo)`, que devuelve `null` para la vitalicia.
2. **`venceEn` pasa a ser nullable en los claims**, con una regla de coherencia: una
   vitalicia **no** lleva fecha y las demás **sí**. La firma de una combinación
   incoherente se rechaza en la verificación (empaquetada en el `refine` de
   `licenseClaimsSchema`).
3. **`resolveLicensing`**: la vitalicia es siempre `licencia_vigente`, con
   `venceEn: null` y `diasRestantes: null`. No hay aviso de «por vencer» ni paso a modo
   consulta por tiempo; el **reloj atrasado** sigue aplicando (es anti-manipulación, no
   comercial).
4. **Emisor**: `--tipo vitalicia` en el CLI y `/vitalicia` en el bot del proveedor.
   `calcularVencimiento` devuelve `null`. Renovar una vitalicia no tiene sentido: si hay
   que reemplazarla (corrección, cambio de titular, fin del soporte) se emite **otra**
   licencia y se activa; la última activada manda.
5. **Registro y vistas**: `venceEn: null` en el JSONL; `/pendientes` excluye las
   vitalicias (no hay nada que renovar); la web y los bots muestran «sin vencimiento».
6. **Revocación**: en una vitalicia no hay fecha que dejar pasar. La palanca es la
   misma que en offline: no hay revocación remota; para «quitarla» se emite una licencia
   que la reemplace o se deja de prestar soporte/actualizaciones.

## Consecuencias

- Es una venta perpetua: el modo consulta **nunca** llega por tiempo. El marcador
  anti-atraso del reloj y la atadura al `installationId` se mantienen igual.
- **No hace falta migración** (los claims viven en JSONB): la fila de la instalación no
  cambia de forma y las licencias viejas, con fecha, se siguen verificando.
- La app nueva acepta ambos formatos; una app vieja que reciba una vitalicia no la
  validaría (mismo `LICENSE_VERSION`, claims incompatibles con su esquema), así que el
  emisor y el despliegue van juntos cuando se cambia el formato.
- El emisor tiene que ser consciente de que renovar una vitalicia con un tipo con días
  la convierte en temporal (empieza a contar desde ahora); es una decisión del
  proveedor, no un accidente del cliente.
