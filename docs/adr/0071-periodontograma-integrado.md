# ADR 0071 — El periodontograma es un examen JSONB versionado del servicio de odontograma

- **Fecha:** 2026-10-18 · **Estado:** aceptada · **Fase:** v1.1 (periodontograma)

## Contexto

El odontograma de la v1 responde a otra pregunta clínica que el periodontograma: guarda
**hallazgos por excepción** (una caries, una corona, una pieza ausente) sobre una boca que
evoluciona fila a fila y se consulta como estado vigente. El periodontograma es un
**documento de examen**: se sondan 192 sitios (32 piezas × 6) en una fecha, se firma y se
compara contra exámenes anteriores. Son dinámicas distintas y el modelo de datos no puede ser
el mismo.

El plan de la v1.1 (`docs/v1.1_periodontograma/plan_primigenio_implementación.md`) propone cinco
decisiones acertadas: **cero `<input>` nativos** (pad táctil propio), un único motor de entrada
para dedo, ratón y teclado, ciclado en un toque para movilidad y furca, **una sola tabla con
`jsonb`** y sin microservicios nuevos, y tuplas posicionales para el SVG. La revisión de ese
plan ([`../v1.1_periodontograma/revision_critica_y_decisiones.md`](../v1.1_periodontograma/revision_critica_y_decisiones.md))
detectó seis riesgos de calidad que este ADR resuelve como decisión, no como detalle de
implementación:

1. El esquema del plan ponía `pd: 2` por defecto: **inventar una medición** en un documento
   clínico es inaceptable; y `pd: 0` confundía «sondado 0 mm» con «no sondado».
2. La tupla posicional `[izq, centro, der]` es correcta solo si **una única función** traduce
   posición visual a anatomía (MV/V/DV o DV/V/MV según el cuadrante); si el gráfico la
   interpreta a mano, el gráfico y el índice se contradicen.
3. El plan sincronizaba en vivo ausentes e implantes desde el odontograma: el examen es un
   documento fechado y debe ser un **snapshot**, no una vista que cambia sola.
4. Guardar el documento completo sin control de concurrencia permite que dos pestañas (o dos
   personas) se pisen las mediciones en silencio.
5. La clasificación AAP/EFP 2018 **no se puede calcular** solo con la sonda: el grado requiere
   pérdida ósea radiográfica/edad, tabaquismo, diabetes y progresión; el estadio requiere
   hallazgos de complejidad que el sistema no captura todos. Un auto-diagnóstico sería un error
   clínico con apariencia de dato.
6. El plan no say qué pasa con el borrador, la revisión ni la impresión: los tres son actos que
   el resto del sistema ya trata con reglas propias (borrador autoguardado, cierre inmutable,
   imprimir es leer).

## Decisión

**1. Módulo del servicio de odontograma, no microservicio nuevo.** El periodontograma vive en
`services/odontogram` y comparte la base del odontograma: leer el estado dental y crear el
examen es **una sola transacción**, sin llamada entre servicios. Las rutas cuelgan del prefijo
existente `/api/v1/odontogram/...` (no se toca el gateway) y reutilizan los permisos
`odontogram:read` / `odontogram:write`; **imprimir es leer**, igual que en el odontograma
(ADR 0031/0032 y decisión 23 del plan maestro).

**2. Una fila por examen con `teeth_data jsonb`.** Tabla `periodontogram_exams`:

- `teeth_data jsonb` con las 32 piezas permanentes en **orden canónico** (maxilar 18→28 y
  mandíbula 48→38), cada una con sus 6 sitios; `metrics jsonb` (KPIs derivados) para listados
  y reportes sin recorrer 192 sitios; `risk_factors` y `diagnosis jsonb`; `status`
  (`borrador` | `finalizado`), `revision`, `schema_version`, fecha clínica `exam_date`, actor
  y fechas de cierre/impresión.
- **Un solo borrador abierto por paciente**: índice único parcial `(patient_id) WHERE
  status = 'borrador'`. Y coherencia de cierre: `(status = 'finalizado') = (finalized_at is not
  null)`, más `jsonb_array_length(teeth_data) = 32`. La base es el último guardián.
- El examen **no** normaliza una tabla por sitio: 192 filas × examen no aportan relación que se
  consulte; el examen es una foto inmutable que se lee entera y se compara entera.

**3. Sin dato no es cero.** `pd` y `gm` son `number | null`; un sitio sin sondar se guarda
`null`, se pinta «—» y **no entra en ningún denominador**. Los índices (BOP %, placa %, medias,
bolsas) se calculan sobre **sitios medidos**, con el denominador explícito en el DTO. Los
implantes se informan en un bloque aparte (`metrics.implant`) porque sus umbrales
(mucositis/periimplantitis) no son los de la dentición natural. El NIC se **deriva**
(`max(0, PS − MG)`), nunca se captura.

**4. La posición es visual; la anatomía la resuelve una función probada.** Los sitios se guardan
en tuplas de 3 en orden visual `[izquierda, centro, derecha]` (barato para el SVG) y
`siteAnatomy(fdi, side, index)` es la **única** traducción a MV/V/DV/MP/P/DP/ML/L/DL. El
esquema rechaza piezas desordenadas, repetidas o incoherentes, y una prueba recorre los 32
dientes para garantizar que las dos lecturas coinciden.

**5. Guardado optimista con revisión y borrador autoguardado.** `PUT .../periodontograms/:id`
lleva la `revision` vigente; si no coincide, 409 con la revisión actual (la interfaz recarga y
avisa). Un guardado idéntico devuelve `unchanged: true` sin escribir ni auditar. La interfaz
autoguarda con debounce; no hay dos escritores silenciosos.

**6. Finalizar es inmutable; corregir es abrir otro examen.** `POST .../finalize` cierra el
documento (idempotente) y a partir de ahí no se edita: la corrección se registra en un examen
nuevo (clon del anterior) y queda en el histórico longitudinal. Descartar un borrador es la
única salida destructiva, auditada.

**7. El examen se congela desde el odontograma; no se sincroniza después.** Al crear el examen,
el servicio lee el odontograma vigente (misma base) y marca ausentes e implantes. A partir de
ahí el snapshot no cambia: una extracción posterior pertenece al siguiente examen, no reescribe
la historia. «Clonar el anterior» copia la boca completa para los controles de mantenimiento.

**8. La clasificación AAP/EFP se sugiere, el odontólogo la firma.** El sistema calcula una
sugerencia explicable (estadio por NIC interproximal, PS máxima, furca ≥ II, movilidad ≥ 2 y
pérdida dental como proxy; grado por tabaquismo, diabetes y HbA1c declarados) con **códigos de
evidencia** traducibles. Lo que se guarda es la `diagnosis` elegida por el profesional, con sus
notas. El sistema no firma diagnósticos.

**9. Auditoría con el resumen, no con la boca entera.** Cada guardado, cierre, impresión y
descarte viaja por el outbox (`odontogram.periodontogram.saved|finalized|printed`) con
`entityType: 'periodontogram'`, actor, KPIs y diff legible (`changedFields` con las piezas
tocadas). El `before`/`after` de auditoría lleva estado, revisión, métricas y diagnóstico —no
duplica 192 mediciones en cada entrada de la auditoría—.

**10. Comparación longitudinal como lectura de primera clase.** `GET .../:examId/compare?with=`
devuelve la boca sitio a sitio con su delta de PS/NIC/BOP, bolsas nuevas o resueltas, piezas
ganadas/perdidas y medias, para que el gráfico superponga el examen anterior y el informe lo
imprima. El umbral de cambio real es 2 mm (ruido de sondaje).

## Consecuencias

- ✅ Cero servicios nuevos y cero cambios de gateway: la v1 no se toca y la v1.1 se despliega
  con una migración aditiva del servicio de odontograma.
- ✅ El examen es un documento: se lee entero, se compara entero y no depende de que el
  odontograma siga diciendo lo mismo dentro de dos años.
- ✅ Los índices no mienten ni por defecto ni por denominador: sin sondar no cuenta.
- ✅ El coste de un examen es una fila (~40 KB de JSONB con las 32 piezas); un historial de años
  cabe en la misma base sin read model.
- ⚠️ El JSONB no se puede consultar sitio a sitio en SQL: los reportes por sitio (futuro) deben
  salir de `metrics`/eventos o de funciones `jsonb`; si algún día hace falta, se añade un read
  model (ADR 0040 es el precedente).
- ⚠️ La posición visual obliga a respetar el orden canónico; el precio es un `superRefine` y una
  prueba de 32 dientes. Un JSON manipulado a mano fuera del contrato no se acepta.
- ⚠️ Autoguardar el documento completo (≈40 KB) con debounce es aceptable en la red del
  consultorio; el guardado por sitio (`PATCH` de sitios sueltos) queda como optimización si la
  medición real muestra latencia.
- ⚠️ Sin radiografía no hay pérdida ósea ni ratio pérdida/edad: el grado sugerido es **solo por
  factores de riesgo**. Sin estadio no se clasifica (no hay periodontitis medible). La extensión
  localizada/generalizada no se implementa en v1.1 para no fingir precisión.
- ⚠️ La dentición temporal y el PSR quedan fuera: el periodontograma estándar de 192 sitios es de
  dentición permanente (base teórica §3). Las piezas con implante se sondan; los ausentes no.
- ⚠️ **Pendiente para la v1.2** (declarado, no olvidado): sumar el resumen del último
  periodontograma finalizado al dossier del expediente y a `reporting` (oral-health), y sembrar
  exámenes deterministas en el modo test. La auditoría ya queda cubierta por los eventos.
