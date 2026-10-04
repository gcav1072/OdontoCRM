# OdontoCRM — guía de uso del consultorio

> **Para quién es.** Para el personal del consultorio: la doctora, la secretaria y
> quien atienda la sala de espera. No hace falta saber nada de computación.
>
> **Lo que hace el sistema:** lleva el día completo —las citas, la sala de espera, la
> historia clínica, el odontograma, los récipes y los reportes— sin papeles sueltos y
> dejando registro de quién hizo cada cosa.

Índice:

1. [Entrar](#1-entrar)
2. [El día completo en una pantalla (`/flujo`)](#2-el-día-completo-en-una-pantalla-flujo)
3. [El consultorio: historia y odontograma](#3-el-consultorio-historia-y-odontograma)
4. [Los récipes](#4-los-récipes)
5. [Pacientes](#5-pacientes)
6. [La agenda: solicitudes, tickets y cupos](#6-la-agenda-solicitudes-tickets-y-cupos)
7. [Las pantallas de la sala y del consultorio](#7-las-pantallas-de-la-sala-y-del-consultorio)
8. [Avisos a los pacientes](#8-avisos-a-los-pacientes)
9. [Reportes y auditoría](#9-reportes-y-auditoría)
10. [Lo que no se hace, y a quién avisar](#10-lo-que-no-se-hace-y-a-quién-avisar)

---

## 1. Entrar

Se abre el navegador en la dirección del consultorio (por ejemplo
`https://odontocrm.local`) y se entra con **usuario y contraseña propios**.

- La primera vez el sistema pide **cambiar la contraseña temporal**: se escribe una
  nueva (mínimo 10 caracteres) y se repite.
- Cada persona tiene **su** usuario. No se comparte: todo lo que se hace queda
  firmado con el nombre de quien lo hizo.
- Cinco intentos fallidos **bloquean la cuenta 15 minutos** (es una protección, se
  desbloquea sola). Si pasa, avisa a quien administra el sistema.
- Arriba a la derecha está el nombre del usuario, el cambio de contraseña y el cierre
  de sesión. Si el sistema está en **modo test** (una franja roja «MODO TEST» arriba),
  son datos de prueba: no se atiende con él.

---

## 2. El día completo en una pantalla (`/flujo`)

Es la pantalla que se usa todo el día. Tiene tres partes:

1. **La cola del día** (izquierda): los pacientes de hoy con su hora, su ticket y en
   qué punto están. Hay un selector de fecha (para ver otro día), un buscador y
   contadores.
2. **El paciente en curso** (centro): su expediente completo —historia, sesión y
   odontograma— sin salir de la pantalla.
3. **La barra de acciones** (arriba): lo que hace la secretaría con cada paciente.

| Acción | Cuándo se usa |
| :--- | :--- |
| **Registrar llegada** | Cuando el paciente llega al consultorio (pasa a «en sala de espera») |
| **Llamar** | Cuando se le llama a consulta; si no llega, se puede llamar otra vez |
| **Pasar a consulta** | Cuando entra al consultorio |
| **Atendido** | Al terminar: pide la sesión clínica cerrada (o un motivo si se atiende sin ella) |
| **Inasistencia** | Cuando no vino (solo pasados 15 minutos de su hora, y con motivo) |

Atajos de teclado, pensados para no soltar el ratón:

- **F2** — buscar paciente
- **F4** — llamar
- **F8** — cerrar la sesión clínica de la visita

En la **tableta** no hay teclado: los mismos atajos están como botones grandes, y la
pantalla se reacomoda sola al tamaño del tablet.

---

## 3. El consultorio: historia y odontograma

**Historia clínica** (pestaña *Historia*). Se llena por pasos y **se guarda sola**;
el aviso de primera visita recuerda que hay que completarla y firmarla.

- Mientras está en **borrador** se puede escribir y corregir todo lo que haga falta.
- Al **firmar** deja de cambiar: si hay que corregir algo, se añade una **adenda con
  el motivo** (así queda la trazabilidad de qué se cambió y por qué).
- Las **alertas clínicas** (diabetes, hipertensión, alergias, anticoagulantes)
  aparecen resaltadas y también en la pantalla del consultorio, para no tener que
  buscar la historia cada vez.
- La historia se imprime en **A4** con el membrete.

**Odontograma** (pestaña *Odontograma*). Se marca **lo que está mal**, no lo que está
bien: un diente sano se queda sin marca.

- Se toca la pieza (o su cara) y se elige el hallazgo: caries, restauración, ausente,
  corona, implante, endodoncia…
- Hay una **hoja táctil de botones grandes** para trabajar con el dedo en la tableta,
  y carga rápida por teclado en el computador.
- Todo lo que se marca queda en la **evolución** del paciente (histórico que no se
  borra) y se puede **deshacer**.
- Se imprime en **A4** en posición anatómica (como se ve al paciente).

**Sesión clínica** (pestaña *Sesión*): es el documento del día (signos vitales, examen,
procedimientos, materiales, diagnóstico, indicaciones y la próxima cita). Se cierra al
terminar la consulta y, desde entonces, **no cambia**: una corrección se hace con una
**enmienda con motivo**. Mientras está abierta se guarda sola, así que un corte de luz
no pierde lo escrito.

En la sesión también se adjuntan **radiografías, fotos y documentos** (con el visor
para verlos en grande).

---

## 4. Los récipes

Se arma el récipe dentro de la sesión (medicamento, presentación, dosis, frecuencia y
duración, con las indicaciones generales) y se **emite**.

- Al emitirlo queda **numerado** (`RX-000001`), con su **PDF A5** archivado y un
  **código de verificación** con QR: quien tenga el papel puede comprobar en la
  dirección pública que ese récipe consta y a nombre de quién está (sin ver datos
  clínicos).
- **Reimprimir** se puede siempre: queda registrado cuántas veces se imprimió.
- **Anular** exige motivo y no borra nada: el récipe anulado se conserva.
- Un récipe emitido **no se edita**. Si hay un error, se anula con motivo y se emite
  uno nuevo.

---

## 5. Pacientes

- El alta se hace con la cédula: el sistema la **normaliza** (V, E, P o SC) y avisa si
  esa persona ya está registrada, en lugar de duplicarla.
- Los **menores** necesitan un representante (nombre, parentesco y teléfono).
- Los datos de contacto se editan **con motivo**: el sistema guarda el valor anterior,
  el nuevo y quién lo cambió (el paciente puede pedir esa trazabilidad).
- En la ficha se adjuntan estudios previos y se ve el historial de visitas.
- **Eliminar** un paciente solo lo puede hacer el administrador, con motivo, y es un
  **borrado lógico**: nada se destruye y la cédula queda libre.

---

## 6. La agenda: solicitudes, tickets y cupos

- Cada solicitud de cita recibe un **ticket consecutivo** (`#000123`), venga del bot,
  del teléfono o del mostrador. La cola se ordena por ticket, antigüedad y prioridad.
- Al **programar** una cita se elige día y hora de la jornada (las franjas ya están
  cargadas: de lunes a viernes, 8:00–12:00 y 13:00–17:00, de 30 minutos).
- El **cupo del día** se puede ajustar; si se baja por debajo de lo ya asignado, el
  sistema avisa y **no borra** ninguna cita.
- El **sobrecupo** solo lo autoriza el administrador, con motivo, y queda auditado.
- **Reprogramar** conserva el ticket y enlaza la cita nueva con la anterior.
- El **aviso en lote** muestra exactamente el texto que se enviará antes de enviarlo.

---

## 7. Las pantallas de la sala y del consultorio

- **Sala de espera** (`/pantalla/lobby`): muestra el turno y el nombre abreviado del
  paciente llamado; el **segundo llamado** aparece en rojo y una **voz en español** lo
  dice en alto. Se actualiza sola, sin recargar.
- **Consultorio** (`/pantalla/consultorio`): el paciente en curso, el motivo de
  consulta y sus **datos críticos en semáforo** (alergias, anticoagulantes, diabetes…).
- Cada televisor o monitor se registra una vez en `/pantallas` con su token y se
  desactiva cuando se retira.

---

## 8. Avisos a los pacientes

En `/notificaciones` está la bandeja: qué se envió, qué está en cola, qué falló y qué
quedó **pendiente de aviso manual** (pacientes que no usan el bot).

- Cuando una cita queda programada, el bot le manda al paciente la **fecha, la hora y
  el lugar**, con un archivo para agregarla a su calendario.
- Si un envío falla, se reintenta solo; si no hay forma de entregarlo, aparece en la
  bandeja para llamarlo por teléfono.
- El estado del bot está arriba: si dice **«Modo simulado»**, los mensajes **no están
  saliendo** — avisa a quien administra el sistema.

---

## 9. Reportes y auditoría

- **`/reportes`**: el día, el embudo de solicitudes y la tasa de inasistencia, la
  ocupación con las horas pico, la demografía, el perfil clínico, la salud bucal y los
  récipes por medicamento. Con filtros de fecha, edad, sexo y estado, y descarga en
  **CSV** (se abre en Excel) y **PDF** para imprimir.
  Los reportes clínicos solo los ven el administrador y la odontóloga.
- **`/auditoria`**: busca por fecha, usuario, acción, entidad o campo y muestra el
  **antes y el después** de cada cambio sensible con su motivo. Es la respuesta a
  «¿quién cambió este teléfono y por qué?».

---

## 10. Lo que no se hace, y a quién avisar

**No se hace nunca:**

- Apagar el servidor «por si acaso»: se apaga desde el menú o se avisa a quien
  administra. Apagarlo de golpe no corrompe los datos, pero corta los avisos.
- Borrar pacientes, historias, sesiones o récipes para «corregir»: el sistema está
  hecho para corregir **sin borrar** (adendas, enmiendas y anulaciones con motivo).
- Compartir usuarios ni contraseñas.
- Usar el sistema si aparece la franja roja **MODO TEST**.

**Avisar cuanto antes si:**

- La aplicación no abre o va muy lenta.
- En `/notificaciones` el bot dice **«Modo simulado»** o hay muchos envíos fallidos.
- Un documento sale raro al imprimir (récipe A5, historia A4, odontograma).
- Se borró algo por error (no se toca nada más: casi todo se puede recuperar del
  respaldo del día).
- El respaldo de la madrugada no aparece en el registro.

> El teléfono y el nombre de quien da soporte están anotados en el **runbook** del
> servidor ([`infra/fedora/RUNBOOK.md`](../infra/fedora/RUNBOOK.md) §9).
