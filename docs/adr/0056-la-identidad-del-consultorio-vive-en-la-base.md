# ADR 0056 — La identidad del consultorio vive en la base de datos

- **Fecha:** 2026-10-08 · **Estado:** aceptada · **Implementada:** sesión de identidad del consultorio (2026-10-08)
- **Relacionada:** [ADR 0054](0054-membrete-unico-en-los-imprimibles.md) — el membrete como fuente única;
  [ADR 0035](0035-datos-criticos-leidos-no-empujados.md) — los datos se **leen**, no se empujan;
  [ADR 0036](0036-recipe-emitido-documento-archivado.md) y [ADR 0048](0048-el-documento-de-cobro-se-archiva.md)
  — los documentos emitidos se archivan; [ADR 0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md) —
  una sola fuente de credenciales; [ADR 0055](0055-dos-tipografias-en-los-imprimibles.md) — las tipografías.

## Contexto

Desde el ADR 0054 el membrete es único y sale de la marca, pero **los datos del
consultorio** —nombre, razón social, dirección, teléfonos, RIF, sitio web, logo y los
odontólogos con su MPPS y su especialidad— vivían en `packages/contracts/src/clinic.ts`
y `brand.ts`: **código compilado**. Poner el sistema con otro odontólogo, o corregir un
RIF mal escrito, exigía editar el repositorio, recompilar y desplegar.

Eso tiene tres consecuencias que se notaron al usar el sistema:

1. **El que sabe los datos no los puede escribir.** El nombre, el MPPS y la especialidad
   los conoce el odontólogo o el administrador del consultorio, no quien despliega. Hoy
   hay que pasar por él para cada corrección.
2. **Nada queda trazado.** Cambiar el membrete era un commit; cambiar un MPPS desde la
   aplicación no existía. En un sistema de salud eso es una asimetría: la historia clínica
   queda auditada y el dato que **firma** el récipe, no.
3. **El registro del odontólogo y su perfil profesional son cosas distintas.** El usuario
   vive en identity (con `mustChangePassword`, roles y auditoría), pero lo que sale
   impreso —MPPS, especialidad, colegiatura— vivía en otro sitio: código. Añadir un
   odontólogo obligaba a tocar los dos.

Se consideró sacarlos a variables de entorno (`CLINIC_*`, como proponía el plan de
facturación, §2.4), pero un `.env` **no es editable desde la aplicación** y obliga a
reiniciar el servicio; no resuelve ni (1) ni (2).

## Decisión

1. **La identidad del consultorio se guarda en la base de `identity`**: dos tablas
   nuevas, `clinic_profiles` (una sola fila) y `dentist_profiles` (una por odontólogo,
   con `completed_at`). El **logo** subido va al **almacén compartido** (`@odontocrm/storage`),
   y en la base solo queda su clave y su tipo MIME.
2. **El odontólogo titular la completa en su primer acceso.** El **titular** es el
   primer usuario con rol `odontologo` (por antigüedad). Él llena los datos del
   consultorio **y** los suyos; los demás odontólogos, solo los suyos. Se pide **una vez**.
3. **El gate no es de la interfaz: es del servidor.** Mientras falte el perfil, el JWT
   lleva `needsProfile` —igual que hoy lleva `mustChangePassword`—, `requirePermission`
   deja **sin permisos** al usuario y el **gateway** corta todo lo que no sea `auth` o
   `identity`. Así el bloqueo no se puede esquivar llamando a la API a mano.
4. **`clinic.ts` no desaparece: pasa a ser respaldo.** Si no hay fila —una instalación
   recién migrada, la base caída, una prueba— se usa su respaldo, así que **nada cambia de
   golpe** y nadie pierde el papel. Hoy ese respaldo es **neutro, sin datos personales**
   ([ADR 0058](0058-sin-datos-personales-en-el-codigo.md)): los campos vacíos **no se
   imprimen** y los avisos que necesitan el consultorio se difieren. Sigue siendo la fuente
   de `ClinicIdentity` (el tipo) y de las ayudas de lectura (`clinicFullAddress`,
   `clinicDentistFor`, `clinicContactReady`, `letterheadMissingFields`…).
5. **Los que componen documentos leen la identidad por la red interna** (ADR 0035): una
   sola ruta, `GET /internal/v1/identity/letterhead?dentist=<usuario>`, que devuelve la
   identidad en la forma de `ClinicIdentity`, **el odontólogo que firma ya resuelto** y el
   **logo incrustado** como `data:` URI. La regla «quién firma» y el respaldo viven en
   identity, no repetidos en cada servicio.
   - `clinical`, `reporting` y `billing` la usan para el membrete del récipe, el dossier,
     el reporte, la factura, el recibo y la nota de crédito.
   - **El logo subido hace también de marca de agua**: es el logo efectivo. La **opacidad
     y el ancho** del velo siguen en `brand.ts` (la marca se edita solo en el código).
   - `notifications`, `scheduling` y `screens` refrescan al arrancar su `CLINIC_NAME` /
     `CLINIC_ADDRESS` / `CLINIC_EMAIL` con lo de la base. **Los overrides `CLINIC_*` del
     entorno se eliminaron** ([ADR 0058](0058-sin-datos-personales-en-el-codigo.md)): la
     base es la única fuente.
6. **Todo cambio de identidad queda auditado.** Acciones nuevas en `AUDIT_ACTIONS`
   (`dentist_profile_completed`, `dentist_profile_updated`, `clinic_profile_updated`,
   `clinic_logo_updated`) con `before`/`after`, campos cambiados, actor y —en las
   **ediciones**— **motivo obligatorio**, igual que los usuarios y los pacientes. El alta
   del onboarding no pide motivo: es un alta, no un cambio.
7. **Se edita desde la aplicación, en dos sitios y con la misma regla:** cada cuenta lo
   suyo en **Mi perfil**, y el administrador a cualquiera desde **`/usuarios`** (permiso
   `users:manage`). El titular edita además los datos del consultorio y el logo.
8. **La marca no se toca.** Paleta, tipografías, medidas del membrete y opacidad del velo
   siguen en `brand.ts`, solo-código (ADR 0055). La identidad **usa** la marca; no la
   reemplaza.

### Eficiencia

Una lectura interna por documento sería cara y, en las pantallas, insostenible. Por eso:

- **Una sola lectura del registro**: sin overrides por entorno
  ([ADR 0058](0058-sin-datos-personales-en-el-codigo.md)), la identidad sale siempre de identity.
- **Caché con TTL corto (~60 s) y deduplicación de llamada en vuelo** en el cliente
  interno (`createLetterheadLookup`, kernel): varias peticiones simultáneas comparten una
  sola lectura, y durante el TTL no se vuelve a preguntar. La identidad cambia rarísimas
  veces.
- **Una sola lectura por documento**: la instantánea se resuelve una vez y se pasa a la
  plantilla.
- **`@font-face` y logo del repositorio memoizados** en el proceso: no cambian en caliente.
- **Degradación limpia**: `AbortSignal.timeout(5 s)` y, si identity no responde, el
  respaldo del código. Un fallo de identity **nunca** bloquea un papel ni un aviso.

## Consecuencias

- **A favor:** quien conoce el dato lo escribe, desde la aplicación y sin recompilar; el
  membrete de una instalación se pone al día sin tocar el repositorio.
- **A favor:** la identidad queda **auditada** (quién, cuándo, qué y por qué) y el gate del
  primer acceso cierra una puerta que antes no existía: hoy un odontólogo recién creado
  puede usar el sistema con su MPPS en blanco.
- **A favor:** un solo sitio resuelve «quién firma» y el respaldo, así que el récipe y la
  factura no pueden divergir en quién emite.
- **En contra / a vigilar:** los PDF y las pantallas dependen de una lectura interna más
  (con timeout y respaldo); si identity se cae, el membrete vuelve al del código y **no**
  se entera nadie más que quien mire el papel. Se acepta: el sistema tiene que seguir
  funcionando.
- **En contra / a vigilar:** `clinic.ts` sobrevive como respaldo, y eso puede confundir
  («¿edito aquí o en la aplicación?»). La regla es clara: **la aplicación manda**; el
  código solo es semilla y red de seguridad, y así está documentado.
- **Cambia lo que decía el ADR 0054** (la identidad era solo-código) y **corrige el §2.4
  del plan de facturación**, que proponía mover `CLINIC` a variables de entorno. Lo que
  **no** cambia: la marca sigue en el código y el membrete sigue siendo único.
- **Los documentos ya emitidos no se reescriben** (ADR 0036, ADR 0048): el récipe
  archivado conserva el PDF con el que se emitió. La identidad nueva sale en lo que se
  componga **de ahora en adelante**.
