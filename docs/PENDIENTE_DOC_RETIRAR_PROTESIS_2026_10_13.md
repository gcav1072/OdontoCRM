# Pendiente de documentación — retirar una PPR/PRT (el borrado validaba mal la ruta)

> **Qué es este archivo.** El arreglo del **borrado de prótesis removibles** (PPR/PRT) —**eliminar**
> una desde su ficha y **deshacer** su registro— ya está en el **código**, pero su **documentación no
> se tocó a propósito**: en la otra PC hay commits sin subir que editan `CHANGELOG.md` y varios docs,
> y meter aquí esas mismas ediciones provocaría conflictos de rama. Este archivo reúne **todo lo que
> hay que actualizar** cuando se fusionen los dos lados; después se puede borrar.
>
> **Regla de oro al aplicarlo:** NO reescribir secciones enteras. Añadir la entrada del CHANGELOG
> **arriba** y tocar los docs con el **mínimo** de líneas, como se indica abajo.

**Qué se arregló (en código, ya hecho):** la ruta
`DELETE /api/v1/odontogram/patients/:patientId/prostheses/:id` le pasaba a Zod el `request.params`
**entero** —que trae `patientId` **e** `id`— al contrato `deleteProsthesisSchema`, que es `.strict()`
y **solo admite `id`**. El `patientId` sobrante se rechazaba como campo desconocido
(`unrecognized_keys`, con `path` vacío) y el kernel lo pintaba como «**Los datos enviados no son
válidos — (cuerpo) (lleva campos que no se admiten)**». Por eso fallaban las **dos** vías que comparten
el mismo cliente (`odontogramApi.removeProsthesis`): **eliminar** la prótesis desde su diálogo y
**deshacer** su registro en el odontograma (que borra las vigentes y vuelve a registrar el snapshot).
Ahora la ruta valida sus `params` con **su propio esquema** (`prosthesisParamsSchema`,
`{ patientId, id }`) y al contrato le pasa **solo** el `id`, igual que la ruta de «dejar la cara sana»
con su input.

---

## 1. `CHANGELOG.md` — entrada nueva (arriba del todo)

Añadir una sección al principio (respetando el estilo Keep a Changelog del archivo), con un texto
equivalente a este:

```markdown
## [Odontograma] — Retirar una PPR/PRT vuelve a funcionar: el borrado valida la ruta · 2026-10-13

**Eliminar o deshacer una prótesis removible** (PPR/PRT) devolvía «Los datos enviados no son válidos
— (cuerpo) (lleva campos que no se admiten)». La ruta de retirada
(`DELETE /api/v1/odontogram/patients/:patientId/prostheses/:id`) le pasaba a Zod **el `params`
entero** —que trae `patientId` **e** `id`— al contrato `deleteProsthesisSchema`, que es `.strict()` y
**solo admite `id`**: el `patientId` sobrante se rechazaba como campo desconocido y, como el fallo de
Zod no traía `path`, el detalle caía en `(cuerpo)`. Ahora la ruta valida sus `params` con su propio
esquema y al contrato le da **solo** el `id`, igual que la ruta de «dejar la cara sana» con su input.
Arregla las dos vías que comparten el mismo cliente: **eliminar** la prótesis y **deshacer** su
registro.

| Pieza | Qué hace |
| :--- | :--- |
| `odontogram-routes.ts` | Nuevo `prosthesisParamsSchema` (`patientId` + `id`) y el borrado de prótesis le pasa al contrato solo `{ id }` |
| `odontogram-server.test.ts` | Regresión del `DELETE .../prostheses/:id` (antes 400 por el `patientId`; ahora llega al servicio) y cobertura 401/403 de `PUT`/`DELETE .../prostheses` |

> **Sin migración.** Es validación de ruta, no datos. El arreglo vive en el `dist` del servicio
> `odontogram`: en producción hay que `sudo odontocrm actualizar` (o `recompilar`) para que entre.
```

---

## 2. Otros docs principales — sin cambios obligatorios

Este arreglo es **validación de una ruta**, no una decisión ni un cambio de reglas ni de modelo de
datos, así que con la entrada del CHANGELOG **basta**. Se deja constancia para que no se busque dónde
más tocar:

- **`docs/ODONTOGRAMA_REGLAS.md` §6 bis (prótesis removibles)** — **no** hay que tocarlo: describe las
  reglas clínicas y la validación del contrato (`recordProsthesisSchema`), no las rutas de borrado.
- **`docs/PLAN_MAESTRO_FASES.md` (tabla de rutas, ≈línea 352)** — la fila `/api/v1/odontogram/**` es un
  **resumen** y hoy solo lista `GET /patients/:id`, `POST /patients/:id/findings` y
  `DELETE /patients/:id/findings`; omite las de **prótesis** (`PUT /patients/:id/prostheses`,
  `DELETE /patients/:id/prostheses/:id`) y `POST /patients/:id/procedures` /
  `DELETE /patients/:id/surfaces/:tooth/:surface`. **Opcional** completar la fila; no es necesario para
  este arreglo.
- **ADR** — **no** procede uno nuevo: es un arreglo de validación de ruta, no una decisión. Si se
  quiere dejar rastro, cabe una línea en las **Consecuencias** del
  [ADR 0062](adr/0062-exodoncia-y-protesis-removibles.md) (las prótesis removibles se retiran por su
  `id`), pero no aporta más que el CHANGELOG.

---

## 3. Seguimiento (NO bloquea este arreglo)

- **Despliegue (gotcha de siempre).** El cambio vive en el `dist` de `services/odontogram`: en
  producción hay que `sudo odontocrm actualizar` (o `recompilar`) y **reiniciar** el servicio. Mientras
  no se despliegue, el arreglo **no** está activo y el borrado de PPR/PRT sigue fallando.
- **Cobertura.** Las rutas de prótesis **no** estaban cubiertas por `odontogram-server.test.ts` (solo
  `findings` y `surfaces`); ya hay regresión del `DELETE` y del `PUT`/`DELETE` ante 401/403. Convendría
  revisar si el patrón `parseOrThrow(contratoEstricto, request.params)` —pasar los `params` crudos a un
  contrato `.strict()`— aparece en **otras** rutas con más de una clave en la URL (aquí se corrigió la
  única del odontograma).
