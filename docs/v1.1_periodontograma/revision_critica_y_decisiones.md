# Periodontograma v1.1 — revisión crítica del plan y decisiones de calidad

Este documento responde a la petición de la v1.1: revisar los dos documentos de partida
([`base_teorica.md`](base_teorica.md) y
[`plan_primigenio_implementación.md`](plan_primigenio_implementación.md)) y ajustar el enfoque
**antes** de escribir código, priorizando la calidad clínica y la deuda técnica cero. No cambia la
visión del plan: lo endurece donde una decisión barata podía convertirse en un dato clínico falso.

## Resumen ejecutivo

El plan primigenio es sólido en lo importante y se ha conservado en un ~80 %:

| Decisión del plan | Veredicto |
| :--- | :--- |
| Cero `<input>` nativos; pad clínico táctil propio | ✅ Se conserva (y se añade undo + teclado físico) |
| Un único motor de entrada para dedo, ratón y teclado | ✅ Se conserva (controlador único) |
| Ciclado en un toque de movilidad y furca | ✅ Se conserva |
| Sin microservicios nuevos; una tabla SQL con `jsonb` | ✅ Se conserva (módulo del servicio de odontograma) |
| Tuplas posicionales `[0,1,2]` y SVG por polilíneas | ✅ Se conserva con una traducción anatómica **única y probada** |
| Rango de PS/MG con valores por defecto (`pd: 2`) | ❌ **Rechazado**: inventa mediciones |
| `pd: 0` como «no sondado» | ❌ **Rechazado**: 0 mm es una medición válida y distinta |
| Sincronizar ausentes/implantes en vivo desde el odontograma | ❌ **Rechazado**: el examen es un snapshot fechado |
| Clasificación AAP/EFP como selector | ⚠️ **Ajustado**: sugerencia explicable + clasificación firmada por el profesional |
| Guardado parcial sin control de concurrencia | ❌ **Rechazado**: revisión optimista + 409 + un solo borrador |
| Impresión en una página | ⚠️ **Ajustado**: informe en carta con las secciones y la evolución en hoja aparte; el documento completo ocupa varias hojas |
| Fase 5 completa (dossier, reporting, seeds, E2E) | ⚠️ **Parcial**: auditoría sí (eventos); lo demás, declarado para v1.2 |

Resultado: la v1.1 entrega el **vertical completo** del periodontograma (contrato → base → servicio
→ interfaz táctil → comparación → informe imprimible → auditoría → herramientas de verificación),
sin tocar el odontograma de la v1 ni el gateway, y con la deuda restante **escrita y justificada**.

---

## 1. Riesgos detectados en el plan y qué se hizo

### R1 · Mediciones inventadas por valores por defecto — **crítico**

El esquema del plan traía `pd: z.number().int().min(0).max(15).default(2)` y `gm: … .default(0)`.
Un examen guardado sin sondar esas piezas viajaría con 2 mm de profundidad y 0 mm de margen
«reales»: los índices, el informe y la comparación dirían cosas que nadie midió. En un documento
clínico eso no es un detalle de UX: es un dato falso con apariencia de medición.

**Decisión implementada:** `pd` y `gm` son `number | null` con `null = no sondado`. Los índices
calculan sobre **sitios medidos** y el denominador viaja en el DTO (`sitesProbed`). `0` es una
medición válida y se muestra como 0. La interfaz pinta «—» en lo no sondeado y no lo cuenta.

### R2 · La tupla posicional podía mentir según quién la lea — **alto**

`[izquierda, centro, derecha]` es correcto y barato para el SVG, pero el significado anatómico de
«izquierda» cambia con el cuadrante (en el 16 la izquierda de la pantalla es distal; en el 26 es
mesial). Si el gráfico, la tabla del informe y la métrica de NIC interproximal resuelven ese `if`
por su cuenta, tarde o temprano uno de los tres se equivoca y el error es **silencioso** (la boca
parece bien y el índice no).

**Decisión implementada:** los sitios siguen siendo posicionales, pero `siteAnatomy()`,
`siteShortLabel()`, `siteIsMesial()` y `isInterproximalSite()` viven en el contrato y son la
**única** traducción. Una prueba recorre los 32 dientes × 2 caras × 3 posiciones y comprueba que se
alcanzan los 9 nombres anatómicos y que la orientación de cuadrante es la correcta. El arreglo de
32 piezas se valida en **orden canónico** (maxilar 18→28 y mandíbula 48→38): un JSON desordenado o
incompleto se rechaza.

### R3 · Sincronizar el odontograma en vivo rompe la historia — **alto**

El plan decía «creación de examen sincronizando automáticamente los dientes extraídos/ausentes e
implantes desde el odontograma activo». Sincronizar **después** haría que un examen de hace un año
cambiara cuando hoy se extrae una pieza: la comparación longitudinal mentiría (la pieza
«desaparecería» del examen anterior) y el documento dejaría de ser un hecho fechado.

**Decisión implementada:** el odontograma se lee **solo al crear** el examen (misma base del
servicio, misma transacción) y el resultado queda congelado en `teeth_data`. «Clonar el anterior»
copia la boca completa para los controles de mantenimiento, pero con la fecha del examen nuevo.

### R4 · Dos pestañas (o dos personas) pisándose las mediciones — **alto**

El plan guardaba el documento completo en cada cambio sin revisión. En una tablet con autoguardado
y un escritorio con el mismo paciente abierto, la última petición gana y las mediciones de la otra
se pierden sin aviso.

**Decisión implementada:** `revision` optimista en la fila; `PUT` con la revisión vigente; si no
coincide → **409** con la revisión actual y la interfaz recarga y avisa. Un guardado idéntico no
escribe ni audita (`unchanged: true`). Además, índice único parcial para que **solo exista un
borrador abierto por paciente**: dos pestañas no crean dos documentos distintos del mismo examen.

### R5 · La clasificación AAP/EFP no se puede calcular sola — **crítico (clínico)**

El plan preveía un «selector de diagnóstico AAP/EFP (Estadio I–IV, Grado A–C)». El estadio combina
severidad, complejidad (furcas, movilidad, colapso) y pérdida dental; el grado exige pérdida ósea
radiográfica frente a la edad, tabaquismo, diabetes (HbA1c) y progresión documentada. Con la sonda
sola, un clasificador automático produciría un diagnóstico con apariencia de certeza que el
profesional no ha firmado.

**Decisión implementada:** el sistema calcula una **sugerencia explicable** (estadio por NIC
interproximal, PS máxima, furca ≥ II, movilidad ≥ 2 y pérdida dental como proxy; grado solo por
factores de riesgo declarados) y devuelve **códigos de evidencia** con su cifra. Lo que se guarda
es la clasificación que elige y firma el odontólogo, con sus notas. Los límites (sin radiografía,
pérdida dental como proxy, sin extensión localizada/generalizada) se muestran en la interfaz y se
documentan en [`../PERIODONTOGRAMA_BASES_CLINICAS.md`](../PERIODONTOGRAMA_BASES_CLINICAS.md).

### R6 · Geometría del SVG infravalorada — **medio**

El plan prometía «menos de 90 líneas» con `viewBox="0 0 640 80"`. Con 15 mm de PS y −15 mm de MG,
la ventana vertical necesaria para la arcada **no cabe** en 80 unidades: la polilínea se saldría
del lienzo justo en los casos graves, que son los que hay que ver. Y la arcada inferior necesita
la dirección de las bolsas espejada respecto a la superior.

**Decisión implementada:** geometría aislada en un módulo puro y probado (`geometry.ts`), un
`viewBox` de 640 × 176 por arcada con escala fija (3,5 unidades/mm) calculada para el peor caso
(MG −15 + PS 15), y dirección de bolsa invertida en la mandíbula. Las zonas de toque se cuantizan
por sitio con un ancho de 13,33 unidades y la selección tiene alternativa en la tabla numérica y en
el pad (para el dedo con guante). Sin librerías de gráficos.

### R7 · Impresión en una sola página — **medio**

Un periodontograma de 32 piezas con 192 cifras (PS y MG) más el gráfico y los KPIs no cabe legible
en una cara vertical. El plan lo daba por hecho.

**Decisión implementada:** informe en **carta vertical**, con el membrete, las dos arcadas, la
rejilla de cifras por sitio con su etiqueta anatómica y los KPIs; la comparación longitudinal (si
se pide) empieza en **hoja aparte**. No se promete una sola cara: 192 cifras legibles no caben, y
prometerlo habría llevado a reducir la tipografía hasta hacer el documento inservible. Se
reutilizan el membrete, el margen de impresión y la marca de agua de los imprimibles existentes.
La impresión es lectura auditada y no bloquea el papel si el registro de la impresión falla.

### R8 · «Menos de 90 líneas» y cero pruebas en la UI — **medio**

El ahorro de líneas no es un criterio de calidad; la lógica de un pad clínico (auto-avance,
selección de sitio, undo, signo de MG, ciclado de grados) es exactamente lo que más se rompe y lo
que nadie revisa a ojo. Se ha separado la lógica pura del componente y se prueba (selección de
siguiente sitio saltando ausentes, aplicación de valores y flags, ciclados, undo, geometría de
coordenadas), además de comprobar el contrato completo en 42 pruebas.

### R9 · Accesibilidad y teclado físico no eran requisito — **bajo, pero barato**

El plan mencionaba el teclado físico «como método secundario» sin detallarlo. Se formaliza: los
sitios son botones con `aria-label` anatómico, foco visible, targets ≥ 44 px (pad 56 px), operables
con dígitos/flechas/B-P-S/M/F y undo con `Ctrl+Z`. El color no es el único indicador de BOP/placa
(hay marca e icono).

### R10 · La fase 5 arrastraba cuatro servicios a la vez — **riesgo de entrega**

Dossier clínico, reporting, semillas y E2E transversales tocan `services/clinical`,
`services/reporting`, `packages/testing` y `tools/`. Meterlos en la misma entrega que el módulo
nuevo multiplica el radio de rotura («sin romper nada» es requisito) sin aportar al flujo clínico
del periodontograma.

**Decisión implementada:** la **auditoría** entra ya (outbox + `entityType='periodontogram'` +
acciones propias), porque es parte del contrato de datos del sistema y se hereda del odontograma.
El **resumen interno** (`/internal/v1/periodontogram/.../summary`) queda listo para el dossier. La
integración en el dossier/expediente, las métricas en reporting, la semilla determinista y los E2E
de la fase 5 quedan **declarados para la v1.2** con el resumen ya calculado y disponible.

---

## 2. Mejoras de calidad incorporadas (además de las correcciones)

1. **Un solo borrador abierto por paciente** (índice único parcial). Evita documentos paralelos del
   mismo examen y deja un estado inequívoco en la interfaz.
2. **`schema_version` en la fila** (y `PERIODONTAL_SCHEMA_VERSION` en el contrato): el JSONB puede
   evolucionar sin adivinar la forma de los documentos viejos.
3. **`metrics jsonb` denormalizado** en la fila: los listados y el futuro reporting no recorren 192
   sitios; el detalle recalcula desde la boca (fuente de verdad) y se comprueba que coinciden.
4. **Checks en la base**: 32 piezas, revisión ≥ 0, estado válido y coherencia
   finalizado ↔ `finalized_at`. El servicio no es el último guardián aunque falle.
5. **Evidencia traducible**: la sugerencia AAP/EFP devuelve códigos (`bolsas_5mm`,
   `furca_avanzada`…) y cifras, no frases en un solo idioma: la interfaz y el informe dicen el
   motivo, no solo el resultado.
6. **Comparación con umbral de ruido**: 2 mm para declarar mejora/progresión; bolsas nuevas y
   resueltas, piezas ganadas/perdidas y delta de BOP. La superposición en el SVG y la tabla de
   deltas comparten el mismo contrato que el servidor.
7. **Impresión = lectura auditada**: mismo permiso que el odontograma, contador de impresiones y
   evento; el papel sale aunque falle el registro (primero el documento, igual que en la v1).
8. **Herramientas de verificación**: humo contra el gateway (`smoke:periodontogram`), comprobación
   de responsive y targets táctiles en las anchuras del consultorio (iPad 768/1024, portátil
   1366, móvil 320).
9. **KPIs de implantes separados**: BOP %, PS media y bolsas ≥ 5 de implantes en su bloque, porque
   mezclarlos con la dentición natural produce un índice que no es comparable con la literatura.
10. **Denominadores explícitos** (`sitesProbed`, `sitesPresent`): un BOP % sin su denominador es
    una cifra que no se puede auditar.

## 3. Sugerencias para la v1.2 (priorizadas)

| Prioridad | Mejora | Por qué |
| :-: | :--- | :--- |
| Alta | Resumen del último examen finalizado en el **dossier** y en la historia clínica | El periodontograma es documento clínico; debe estar en el expediente que se imprime/archiva |
| Alta | Métricas periodontales en `reporting` (`oral-health`) | BOP%, bolsas y retratamiento son KPIs de resultado; el evento ya lleva el resumen |
| Media | Semilla determinista de exámenes en modo test (`packages/testing`) | Sin datos de demo el módulo no se puede probar E2E ni enseñar |
| Media | E2E del flujo táctil (Playwright) dentro de `check-responsive`/`e2e-flujo` | La interacción con dedo/ratón es el corazón del módulo |
| Media | Periodontograma **de control** que solo guarde los sitios que cambian (`PUT` por sitios) | Menos tráfico y menos conflictos en bocas estables |
| Media | Extensión localizada/generalizada medida (% de piezas con NIC ≥ umbral) | Completa la clasificación 2018 sin fingir precisión |
| Baja | Adjuntar radiografías al examen (el almacén cifrado ya existe) | Sustenta el grado y el diagnóstico; hoy el grado es solo por factores de riesgo |
| Baja | Exportar el examen a PDF en el servidor (como facturas/récipes) | Hoy se imprime desde el navegador; el dossier necesitará el documento archivado |
| Baja | PSR por sextantes y dentición temporal | Fuera del alcance del periodontograma estándar de 192 sitios (base teórica §3) |
| Baja | Calibración/duplicado de sondaje por dos operadores | Requiere modelo de roles y consenso; hoy un examen, un sondeador responsable |

## 4. Criterio de «sin romper nada»

La v1.1 es **aditiva**: tabla y rutas nuevas, contrato nuevo, componentes nuevos y una pestaña
nueva. El odontograma, la historia, la sesión, la caja y la agenda no cambian de comportamiento.
La verificación de cierre es la del repositorio (`lint`, `format`, `typecheck`, `build`, `test` al
completo) más la migración aditiva del servicio de odontograma. Cualquier dolor de integración se
resuelve en el módulo nuevo, no relajando la v1.
