# Periodontograma — bases clínicas de la v1.1

Este documento fija **qué mide el periodontograma de OdontoCRM, cómo se calcula y qué no
promete**. La teoría clínica de partida está en
[`v1.1_periodontograma/base_teorica.md`](v1.1_periodontograma/base_teorica.md) y las decisiones
de arquitectura en el [ADR 0071](adr/0071-periodontograma-integrado.md). Aquí se recoge la
convención **tal como la implementa el sistema**, para que servidor, interfaz, informe y
auditoría digan lo mismo.

## 1. Qué es y qué no es

- Es un **documento de examen fechado**: la boca completa sondeada en una fecha, con sus
  mediciones, sus factores de riesgo y la clasificación que firma el odontólogo.
- Es **longitudinal**: cada control es un examen nuevo; la comparación entre exámenes es la que
  muestra la respuesta al tratamiento. Un examen finalizado **no se edita**.
- **No sustituye** a la radiografía ni a la historia clínica. El sistema no interpreta imágenes,
  no calcula pérdida ósea radiográfica y no emite diagnóstico automático.
- **No** implementa periodontograma de dentición temporal ni PSR por sextantes: sondeamos las
  **32 piezas permanentes** (18–28 y 48–38). Un paciente en dentición mixta puede tener un
  periodontograma de sus piezas permanentes; las temporales no se dibujan aquí.

## 2. Los 6 sitios por pieza y su nombre

Por cada pieza presente se registran **6 sitios** (3 vestibulares y 3 linguales/palatinos):

| Cara externa (vestibular) | Cara interna (palatina arriba / lingual abajo) |
| :--- | :--- |
| Mesiovestibular (MV) · Vestibular medio (V) · Distovestibular (DV) | Mesiopalatino (MP) · Palatino medio (P) · Distopalatino (DP) — o Mesiolingual (ML) · Lingual (L) · Distolingual (DL) en la mandíbula |

La enfermedad periodontal es **sitio-específica**: la destrucción empieza en el col
interproximal, por eso se sondan mesial y distal de cada cara y no solo el centro. Un examen que
solo mire el centro de la cara infradiagnostica la mayor parte de las bolsas interproximales.

**Cómo se guarda y por qué se ve bien.** Los tres sitios de cada cara se guardan en una tupla en
**orden visual de izquierda a derecha**, y `siteAnatomy()` (contratos) traduce esa posición a su
nombre anatómico según el cuadrante: en los cuadrantes del lado derecho del paciente (1 y 4) la
izquierda de la pantalla es el lado **distal**; en los izquierdos (2 y 3), el **mesial**. El
gráfico, la tabla del informe y la impresión usan esa misma función; si se duplicara el `if` en
cada uno, un día el gráfico y el índice dirían cosas distintas.

## 3. Variables por sitio

### 3.1 Profundidad de sondaje (PS / PD)

Distancia en mm desde el **margen gingival** hasta el fondo del surco o bolsa, con sonda
milimetrada calibrada (0,20–0,25 N). Se registra en **mm enteros de 0 a 15**.

- **Sin sondar = `null`**, no 0 ni 2. El sistema **nunca** rellena una medición que no se hizo:
  un «2 mm» inventado falsearía los índices y el informe. La interfaz lo pinta «—».
- En el informe y en el pad, 12 significa **≥ 12 mm** (el tope operativo de la sonda; el dato se
  guarda como 12).

### 3.2 Margen gingival (MG / GM) — convención de signos

Distancia desde el LAC hasta el borde libre de la encía, en mm enteros de −15 a +10:

- **`MG = 0`**: el margen está a nivel del LAC.
- **`MG < 0` (recesión)**: el margen migró hacia apical y hay cemento expuesto; MG = −3 son 3 mm
  de recesión.
- **`MG > 0` (hiperplasia / agrandamiento)**: el margen cubre esmalte coronal al LAC.

`MG` puede quedar **sin registrar** (`null`). Para calcular el NIC se asume entonces **`MG = 0`
(margen a nivel del LAC)**: es una convención de cálculo, no un valor que se escriba en la
historia. La interfaz permite marcar el signo con un toque (−/+), que es lo único que necesita el
flujo táctil.

### 3.3 Nivel de inserción clínica (NIC / CAL) — derivado

**Nunca se captura a mano.**

```
NIC = max(0, PS − MG)        con MG = 0 si no se registró
```

Es la métrica reina: mide el soporte realmente perdido respecto al LAC, y es la que evita los
errores de leer solo la PS.

| Escenario | PS | MG | NIC | Lectura |
| :--- | :-: | :-: | :-: | :--- |
| Pseudobolsa por hiperplasia | 5 | +3 | 2 | Hay bolsa por inflamación, no pérdida de inserción |
| Bolsa verdadera sin recesión | 5 | 0 | 5 | Pérdida real de 5 mm |
| Bolsa + recesión severa | 5 | −4 | 9 | El pronóstico es peor que lo que sugiere la PS |
| Recesión pura, surco sano | 2 | −4 | 6 | Pérdida histórica, periodonto hoy estable |

Un sitio **sin PS** no tiene NIC (`null`). Sin datos no se inventan ceros.

### 3.4 Variables dicotómicas

- **BOP (sangrado al sondaje):** sangrado dentro de los 15–30 s posteriores al sondaje. Es el
  marcador de inflamación activa; un sitio sin BOP tiene altísima probabilidad de mantener su
  soporte. Umbral de salud/gingivitis controlada: **BOP < 10 %**.
- **Placa (biofilm):** presencia de placa a nivel dentogingival. Meta de higiene: **< 20 %** de
  los sitios. En este módulo se registra **por sitio** (6 por pieza) y se informa como «placa por
  sitios»: no se llama índice de O'Leary porque O'Leary se define por superficies (4 por pieza),
  y cambiar el denominador en silencio sería un dato falso.
- **Supuración:** salida de pus al sondear o presionar; infección supurativa activa.

## 4. Variables por pieza

### 4.1 Movilidad (Miller)

| Grado | Significado |
| :-: | :--- |
| 0 | Fisiológica (0,1–0,2 mm por elasticidad del ligamento) |
| 1 | Horizontal perceptible hasta 1 mm |
| 2 | Horizontal > 1 mm, sin componente vertical |
| 3 | Horizontal severa + movilidad vertical/axial |

Se puede dejar **sin evaluar** (`null`), que no es lo mismo que grado 0.

### 4.2 Lesión de furca (Hamp, Nyman y Lindhe)

| Grado | Significado |
| :-: | :--- |
| 0 | Sin lesión (se representa por la **ausencia** de la entrada) |
| I | Pérdida horizontal ≤ 3 mm |
| II | Pérdida > 3 mm que **no** atraviesa la furca (cul-de-sac) |
| III | Atravesada (*through-and-through*) |

**Mapa anatómico estricto** (validado por el contrato y por la base):

| Piezas | Raíces | Entradas de furca |
| :--- | :--- | :--- |
| Molares superiores 18, 17, 16, 26, 27, 28 | 3 (MV, DV, palatina) | `vestibular`, `mesiopalatina`, `distopalatina` |
| Molares inferiores 48, 47, 46, 36, 37, 38 | 2 (mesial, distal) | `vestibular`, `lingual` |
| Primeros premolares superiores 14, 24 | 2 en el 60–80 % | `mesial`, `distal` |

El resto de piezas (incisivos, caninos, segundos premolares, terceros molares superiores) **no
tiene furca**: el sistema rechaza el dato. Tampoco se admiten furcas ni movilidad en implantes ni
en piezas ausentes.

### 4.3 Piezas ausentes e implantes

- **Ausente:** no tiene sitios, ni movilidad, ni furca. Se excluye de los denominadores.
- **Implante:** se **sondean sus 6 sitios** (mucositis/periimplantitis), pero no tiene LAC, ni
  furca, ni movilidad fisiológica. Sus índices se informan en un **bloque aparte**
  (`metrics.implant`) porque el umbral diagnóstico no es el mismo que el de la dentición natural.
  El estado ausente/implante se toma del odontograma al **abrir** el examen y queda congelado en
  el documento.

## 5. Índices del examen (calculados por el sistema)

Todos los porcentajes usan como denominador **los sitios realmente medidos** de las piezas
naturales presentes; los sitios sin sondar no cuentan (ni a favor ni en contra).

| Índice | Fórmula | Uso |
| :--- | :--- | :--- |
| BOP % | sitios con BOP / sitios medidos × 100 | < 10 % = inflamación controlada |
| Placa % | sitios con placa / sitios medidos × 100 | < 20 % = higiene compatible con mantenimiento |
| PS media / NIC medio | media de los sitios medidos | tendencia longitudinal |
| PS máxima / peor NIC | máximo medido | severidad y pronóstico |
| Peor NIC interproximal | máximo NIC de los sitios mesial/distal | base del **estadio** |
| Bolsas ≥ 4 / ≥ 5 / ≥ 6 mm | conteos | severidad y objetivo terapéutico |
| Bolsas ≥ 4 mm que sangran | conteo | bolsa abierta |
| Sitios de retratamiento | PS ≥ 5 **o** (PS = 4 **y** BOP) | objetivo EFP S3: sin bolsas ≥ 5 mm y sin bolsas de 4 mm sangrantes |
| Lesiones de furca / piezas con movilidad ≥ 1 / ≥ 2 | conteos | complejidad |

La interpretación de la PS (surco fisiológico 1–3, bolsa 4–5, profunda ≥ 6) y los umbrales de
BOP/placa son los de la base teórica (§4 y §6).

## 6. Clasificación AAP/EFP 2018 — sugerencia y decisión

El sistema **sugiere** y el odontólogo **firma**:

### 6.1 Estadio (sugerencia basada en lo medido)

| Condición medida | Sugerencia |
| :--- | :--- |
| ≥ 5 piezas perdidas (proxy de pérdida dental) | Estadio IV |
| NIC interproximal ≥ 5 mm **o** PS ≥ 6 mm **o** furca ≥ II **o** movilidad ≥ 2 | Estadio III |
| NIC interproximal 3–4 mm | Estadio II |
| NIC interproximal 1–2 mm | Estadio I |
| Ninguna de las anteriores | Sin estadio (no hay periodontitis medible) |

### 6.2 Grado (sugerencia por factores de riesgo declarados)

| Factor declarado | Grado |
| :--- | :--- |
| Fumador ≥ 10 cigarrillos/día **o** diabetes no controlada **o** HbA1c ≥ 7 % | Grado C |
| Fumador < 10 cigarrillos/día **o** diabetes controlada **o** HbA1c 6,5–6,9 % | Grado B |
| Sin factores | Grado A |

Cada sugerencia viene con **códigos de evidencia** (`nic_interproximal`, `bolsa_profunda`,
`furca_avanzada`, `movilidad_avanzada`, `dientes_perdidos`, `bolsas_5mm`, `tabaquismo`,
`diabetes`, `hba1c`) y su cifra, para que el profesional vea **por qué** el sistema propone lo que
propone. La clasificación que se guarda es la que él elige, con sus notas.

### 6.3 Límites declarados (no son un bug)

- **No se calcula el grado por pérdida ósea/edad** (requiere radiografía) ni por progresión
  documentada: el sistema no tiene esa serie. La sugerencia de grado es **solo por factores de
  riesgo**, y así se muestra.
- **La pérdida dental es un proxy**: el sistema no sabe si esas piezas se perdieron por
  periodontitis, caries, trauma o agenesia. Por eso el estadio se presenta como sugerencia.
- **La extensión localizada/generalizada no se implementa en v1.1**: sin un criterio medido y
  consensuado en el sistema, se preferiría un dato inventado a un dato útil. El profesional puede
  anotarla en las notas de la clasificación.
- **No hay integración con radiografías** ni con laboratorio (HbA1c se declara a mano, opcional).

## 7. Comparación longitudinal

Al comparar dos exámenes del mismo paciente:

- Se comparan sitio a sitio las dos bocas (192 sitios) y se informa el **delta de PS y de NIC**.
- Se considera **cambio real** cuando la diferencia de PS o de NIC llega a **2 mm** (el ruido de
  sondaje habitual ronda 1 mm; un cambio de 1 mm no se pinta como mejora ni como progresión).
- Se cuentan **bolsas nuevas** (≥ 5 mm donde antes no había) y **resueltas** (≥ 5 mm que ya no
  están), **piezas perdidas/ganadas** entre exámenes, y el **delta de BOP %**.
- Comparar un examen consigo mismo devuelve todo estable: no hay que impedirlo, pero el informe
  no debe usarlo como «evolución».

## 8. Ciclo de vida del documento

1. **Crear** (borrador): la boca nace del odontograma vigente (ausentes e implantes) o en blanco,
   o clonando el examen anterior para un control de mantenimiento. Solo puede haber **un
   borrador abierto por paciente**.
2. **Guardar** (borrador): autoguardado con **revisión optimista**; si otra pestaña guardó antes,
   el servidor responde 409 y la interfaz recarga. Un guardado sin cambios no escribe ni audita.
3. **Finalizar**: cierre **inmutable**, con quién y cuándo. Después solo se lee, se compara y se
   imprime.
4. **Corregir**: no se edita lo finalizado; se abre un examen nuevo y la evolución queda en el
   histórico.
5. **Descartar**: solo un borrador, y queda auditado.
6. **Imprimir**: es lectura (permiso `odontogram:read`) y deja constancia con actor y contador,
   igual que el odontograma.

## 9. Glosario mínimo

- **LAC / CEJ:** límite amelocementario; referencia fija del sistema.
- **MG:** margen gingival; referencia móvil.
- **PS:** profundidad de sondaje.
- **NIC / CAL:** nivel de inserción clínica (soporte perdido).
- **BOP:** sangrado al sondaje.
- **Bolsa:** PS ≥ 4 mm; profunda desde 6 mm.
- **Retratamiento (EFP S3):** PS ≥ 5 mm o PS = 4 mm con BOP.
- **Furca:** lesión del techo interradicular (Hamp I–III).
- **Estadio/Grado:** clasificación AAP/EFP 2018 de severidad/complejidad y de progresión/riesgo.
