# SPEC — Batch Diario de Sincronización de Actividades

> Especificación funcional (estilo SDD — *Spec-Driven Development*). Describe **qué** debe hacer el batch y **por qué**, no el cómo. El cómo (scheduler, concurrencia, infra) está en [ADR-004](../adr/ADR-004-cron-jobs.md).

| | |
|---|---|
| **Feature ID** | F6-01 (ver MVP — Fase 6) |
| **Estado** | Borrador para implementación |
| **Fecha** | 2026-06-06 |
| **ADR relacionado** | [ADR-004 — Estrategia para el batch diario](../adr/ADR-004-cron-jobs.md) |
| **Módulo destino** | `src/modules/scheduler/` |

---

## 1. Propósito

Cada día, de forma automática y a la hora que cada empleado configuró, el sistema debe **recolectar la actividad laboral** del empleado desde **Google Calendar**, **Google Drive** y **Jira**, **persistirla** en la base de datos, y **avisarle por email** que su actividad del día ya está disponible para revisar en el dashboard.

El batch es la pieza que automatiza la recolección descrita en el MVP (punto 3, "Recolección de actividad diaria … 1 vez al día").

## 2. Objetivos y No-objetivos

**Objetivos**
- Disparar la sincronización por usuario según su jornada configurada (`workEndTime`).
- Sincronizar todas las fuentes conectadas de cada empleado de forma idempotente.
- Notificar por email al empleado al cierre de su sincronización, solo si hubo actividad.
- Ser resiliente: el fallo de una fuente o de un usuario no debe frenar al resto.
- Respetar los *rate limits* de las APIs externas en el pico de carga.

**No-objetivos** (fuera de alcance de esta spec)
- Generación del **informe IA**: se hace **on-demand** cuando el empleado entra al dashboard, no en el batch (decisión de equipo).
- Contenido del informe en el email: el email es solo **aviso + link**, no incluye el resumen ni adjuntos.
- Consolidación / cálculo de solapamientos (`avoidOverlaps`), que es una preocupación de lectura/visualización, no de sincronización.
- Soporte multi-instancia / alta disponibilidad del scheduler (ver ADR-004: se asume **una sola instancia**).
- Catch-up de corridas perdidas por proceso caído (ver §8 E-02).
- Re-ejecución manual de la sincronización por el administrador (no existe en este alcance).

## 3. Actores

| Actor | Descripción |
|---|---|
| **Scheduler (Sistema)** | El dispatcher automático. Actor primario y único del flujo diario. |
| **Empleado** | Usuario con rol `EMPLOYEE` y estado `ACTIVE`. Configura su jornada y recibe el email. |

## 4. Supuestos y dependencias

- **Decisiones tomadas** (ver historial de ADR-004 y de esta spec):
  - **Una sola instancia** del contenedor `app`.
  - Ante fallo de un usuario: **aislar, loguear y seguir** (sin reintento automático; la idempotencia permite recuperar en la corrida del día siguiente).
  - Disparo: **dispatcher cada minuto** (`* * * * *`).
  - Timezone: **env única `SCHEDULER_TIMEZONE`** (IANA).
  - El batch **no** genera informe IA; el email es **aviso + link**; **sin actividad → sin email**.
- **Hora de disparo:** se usa `workEndTime` (la jornada ya existente). `workEndTime`/`workStartTime` se guardan como `"HH:MM"` **sin zona** (verificado en el modelo `User`); se interpretan en `SCHEDULER_TIMEZONE`.
- **Servicios de sincronización existentes** que el batch orquesta (ya son *caller-agnostic*):
  - `calendar.persistCalendarActivities(userId, refreshToken, fecha)`
  - `drive.persistDriveActivities(userId, refreshToken, inicio, fin)`
  - `jira.syncForUser(userId, inicio, fin)`
- **Infraestructura de email** (nodemailer + SMTP): **no existe aún**; es una dependencia a crear. Cada empresa self-hosted configura su propio SMTP por env.
- **Tensión con el MVP:** el doc del MVP lista "Notificaciones push/email" como *fuera de MVP* y "Notificaciones (recordatorios)" como deseable. El email de **aviso de sincronización** de esta spec se considera parte del entregable del job diario y se distingue de los recordatorios deseables. Confirmar con el cliente si se quiere mantener (ver §13).

## 5. Casos de Uso

### CU-01 — Disparo automático del batch (tick del dispatcher)
- **Actor:** Scheduler.
- **Precondición:** app iniciada; `SCHEDULER_TIMEZONE` válida.
- **Disparador:** cada minuto.
- **Flujo principal:**
  1. Calcular el `HH:MM` actual en `SCHEDULER_TIMEZONE`, en **formato de 24 horas** (luxon `HH:mm`, no `hh`). Así `09:00` ≠ `21:00`.
  2. Buscar usuarios `EMPLOYEE` + `ACTIVE` cuyo `workEndTime` (también 24h) == `HH:MM`.
  3. Si no hay coincidencias → fin del tick (no-op).
  4. Despachar los usuarios coincidentes al pool de concurrencia acotada.
  5. Por cada usuario → **CU-02**.
- **Postcondición:** cada usuario coincidente quedó procesado o con su fallo registrado.
- **Flujos alternativos:**
  - 4a. *Solapamiento con un tick previo aún en curso:* el pool compartido acota la concurrencia total; los nuevos esperan turno (no se lanzan en paralelo sin control).

### CU-02 — Sincronización de la actividad diaria de un empleado
- **Actor:** Scheduler (vía CU-01).
- **Precondición:** usuario `EMPLOYEE` + `ACTIVE`.
- **Flujo principal:**
  1. Construir la ventana `[inicio, fin)` de la jornada del usuario (`workStartTime`→`workEndTime`) interpretada en `SCHEDULER_TIMEZONE` y convertida a UTC.
  2. Si **Google** está conectado (`refreshToken` presente) y **no** requiere reconexión (`googleReconnectRequired == false`) → sincronizar **Calendar** y **Drive** y persistir.
  3. Si **Jira** está conectado (`jiraRefreshToken` + `jiraCloudId`) y **no** requiere reconexión (`jiraReconnectRequired == false`) → sincronizar **Jira** y persistir.
  4. Agregar resultados por fuente (cantidad importada / duplicados omitidos).
  5. Consultar si el usuario tiene **≥ 1 actividad** para el día procesado. Si la hay → **CU-03**. Si no → fin sin email.
- **Postcondición:** actividades del día persistidas de forma idempotente.
- **Flujos alternativos / excepciones (todas aisladas, no abortan el batch):**
  - 2a. Google no conectado o `googleReconnectRequired` → se omiten Calendar y Drive; se loguea; continúa.
  - 2b. Falla la API de Google (timeout / 5xx / 401) → se omite esa fuente; se loguea; un 401/credenciales inválidas marca `googleReconnectRequired = true`.
  - 3a. Jira no conectado → se omite Jira.
  - 3b. Falla Jira → se omite; se loguea; `invalid_grant` marca `jiraReconnectRequired = true` (comportamiento ya implementado en `jira.syncForUser`).
  - 5a. Sin actividad → no se envía email ni se crea Report.

### CU-03 — Notificación por email al empleado
- **Actor:** Scheduler.
- **Precondición:** el usuario tiene ≥ 1 actividad para el día procesado.
- **Flujo principal:**
  1. Enviar email a `user.email` con: aviso de que su actividad del día ya está disponible + **link al dashboard** (`FRONTEND_BASE_URL` + `/dashboard`).
- **Flujos alternativos:**
  - 1a. Falla el envío (SMTP no configurado / caído, dirección inválida) → se loguea y se continúa. **No** se reintenta: la actividad ya quedó persistida en `daily_activities` y visible en el dashboard, así que no hay pérdida de información.

> **Nota:** el batch **no** crea ni modifica la tabla `Report`. Solo persiste actividades (CU-02) y notifica (CU-03). El informe (`Report`) se genera on-demand en otro flujo, fuera de alcance.

## 6. Reglas de Negocio

| ID | Regla |
|---|---|
| **RN-B01** | Solo se procesan usuarios con rol `EMPLOYEE` **y** estado `ACTIVE`. |
| **RN-B02** | El batch corre **una vez por día por usuario**, disparado cuando el `HH:MM` actual en `SCHEDULER_TIMEZONE` coincide con su `workEndTime`. |
| **RN-B03** | *Idempotencia de actividad:* re-sincronizar no duplica actividades (unique `userId + source + externalId` + `skipDuplicates`). |
| **RN-B04** | *Notificación best-effort:* el email de aviso se envía una sola vez al terminar de procesar al usuario. Si falla, se registra y **no** se reintenta: la actividad ya quedó persistida en `daily_activities` y visible en el dashboard, así que no hay pérdida de información. El batch **no** usa la tabla `Report` como ancla. |
| **RN-B05** | *Aislamiento de fallos:* el fallo de una fuente o de un usuario no aborta el procesamiento del resto. |
| **RN-B06** | *Fuentes parciales:* cada fuente conectada se sincroniza de forma independiente; las no conectadas se omiten sin marcar error. |
| **RN-B07** | *Sin actividad → sin notificación:* si el usuario no tiene actividad para el día, no se envía email. (El batch no crea Report en ningún caso.) |
| **RN-B08** | El email se envía **solo** a la dirección del propio usuario y contiene únicamente aviso + link (sin detalle de actividad ni datos sensibles en el cuerpo). |
| **RN-B09** | *Concurrencia acotada:* el fan-out se procesa con un límite de ejecuciones simultáneas para respetar los *rate limits* de Google y Jira. |
| **RN-B10** | El scheduler asume **una sola instancia**; correr múltiples réplicas duplicaría sincronizaciones y emails (restricción operativa, ver ADR-004). |
| **RN-B11** | Una jornada que **cruza la medianoche** (`workEndTime < workStartTime`, p. ej. turno 21:00→02:00) es válida; la ventana abarca desde el día calendario anterior. |
| **RN-B12** | Token revocado / reconexión requerida (`googleReconnectRequired` / `jiraReconnectRequired`) → la fuente se omite y se marca el flag; no se reintenta esa fuente hasta que el usuario reconecte. |
| **RN-B13** | El match de hora usa formato **24 horas** `HH:MM`: `workEndTime = 09:00` dispara únicamente a las 09:00 y nunca a las 21:00. El `HH:MM` actual debe calcularse en 24h (luxon `HH:mm`, no `hh`). |

## 7. Validaciones

| ID | Validación | Cuándo | Si falla |
|---|---|---|---|
| **V-01** | `SCHEDULER_TIMEZONE` es un identificador IANA válido. | Al iniciar la app. | *Fail-fast:* la app no arranca el scheduler. |
| **V-02** | Configuración SMTP presente (`SMTP_HOST`, etc.). | Al enviar el email. | El envío degrada: la sincronización igual ocurre y se persiste; el email se omite y se loguea. No bloquea el batch. |
| **V-03** | `workStartTime` / `workEndTime` con formato `HH:MM`. | Ya validado al guardar settings (`users.service`). | No aplica en el batch (dato ya válido en BD). |
| **V-04** | Ventana `[inicio, fin)` válida tras resolver el cruce de medianoche (inicio < fin en instantes absolutos). | Al construir la ventana por usuario. | Se omite el usuario; se loguea (no debería ocurrir con datos válidos). |
| **V-05** | El `HH:MM` actual se calcula en formato **24 horas** (luxon `HH:mm`). | En cada tick (CU-01). | Bug de formato 12h haría coincidir AM y PM (ver RN-B13); cubrir con test. |

## 8. Casos borde

| ID | Caso | Comportamiento esperado |
|---|---|---|
| **E-01** | Cambio de horario (DST): el `workEndTime` no existe o se repite ese día. | Comportamiento de luxon en `SCHEDULER_TIMEZONE`; puntualmente la corrida puede saltarse o duplicar el match ese día. Documentado como limitación conocida. |
| **E-02** | El proceso está caído en el minuto exacto del match. | No hay catch-up: la corrida del día se pierde (limitación conocida). El empleado puede cargar actividad manualmente desde el dashboard. |
| **E-03** | Casi todos los usuarios comparten `workEndTime` (thundering herd). | El pool acota la concurrencia; drenar el pico puede tardar más de 1 minuto (aceptable). |
| **E-04** | Usuario sin ninguna integración conectada. | No hay actividad → no email, no Report (RN-B07). |
| **E-05** | La sincronización fue OK pero el envío de email falla. | Se loguea y se sigue. **No** se reintenta: la actividad ya está persistida y visible en el dashboard (RN-B04). |
| **E-06** | El usuario cambia su `workEndTime` durante el día. | El match usa el valor vigente al momento de cada tick. |
| **E-07** | Aparece actividad después del `workEndTime` (trabajo posterior al cierre). | No se captura en la corrida del día (la ventana cierra en `workEndTime`). El empleado puede agregarla manualmente desde el dashboard. |
| **E-08** | Restart del proceso a mitad del batch. | La corrida se interrumpe sin reanudar; recuperación al día siguiente (idempotencia evita daño). |
| **E-09** | Doble match puntual del mismo usuario (p. ej. repetición de hora por DST, ver E-01). | La idempotencia de actividad (RN-B03) evita duplicar; el email podría enviarse dos veces ese día puntual (aceptable). |

## 9. Requisitos No Funcionales

| ID | Requisito |
|---|---|
| **RNF-01** | *Portabilidad:* corre dentro del contenedor Node, agnóstico del OS del host (distribución self-hosted). |
| **RNF-02** | *Sin infraestructura extra:* no requiere Redis ni cron del SO. |
| **RNF-03** | *Observabilidad:* logs estructurados (Winston) por tick, por usuario y por fuente: inicio/fin, conteos importados/omitidos, errores y duración. Sin PII en logs (solo `userId`). |
| **RNF-04** | *Rendimiento:* soportar el pico (casi todos los usuarios a la misma hora) con concurrencia acotada configurable (`SCHEDULER_CONCURRENCY`). |
| **RNF-05** | *Seguridad:* tokens cifrados (ya implementado); email solo al propietario; no exponer datos sensibles en cuerpo ni logs. |
| **RNF-06** | *Configurabilidad por env:* `SCHEDULER_TIMEZONE`, `SCHEDULER_CONCURRENCY`, `SMTP_*`, `FRONTEND_BASE_URL`. |

## 10. Modelo de datos y configuración

**Variables de entorno nuevas / usadas**
- `SCHEDULER_TIMEZONE` — IANA (p. ej. `America/Argentina/Buenos_Aires`). Validar al inicio (V-01).
- `SCHEDULER_CONCURRENCY` — máximo de usuarios procesados en paralelo (default sugerido: 5).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — para nodemailer.
- `FRONTEND_BASE_URL` — ya existe en `shared/config`; base del link del email.

**Persistencia del batch — solo `daily_activities`:**
- El batch escribe **únicamente** en la tabla `daily_activities` (modelo `DailyActivity`, que ya existe).
- **NO** crea ni modifica `Report`: la generación del informe (y su fila `Report`, incluido `totalHours`) es **on-demand**, fuera de alcance.

**Índice recomendado en `users`:**
- La query del dispatcher (`role = EMPLOYEE AND status = ACTIVE AND work_end_time = 'HH:MM'`) corre **cada minuto**. Para una instancia self-hosted la tabla `users` suele ser chica (decenas a cientos de filas), por lo que un *seq scan* es aceptable; aun así se recomienda un índice compuesto (p. ej. `@@index([status, role, workEndTime])`) como optimización defensiva de bajo costo.

**Sin nueva tabla de "batch runs":** la auditoría se hace por logs (decisión ADR-004).

## 11. Criterios de Aceptación

> Formato Dado / Cuando / Entonces. Cada criterio es verificable con tests (Jest).

- **CA-01 (CU-01, RN-B01/RN-B02):** *Dado* un empleado activo con `workEndTime = 18:00`, *cuando* en `SCHEDULER_TIMEZONE` son las 18:00, *entonces* se dispara su sincronización; *y* un usuario `ADMIN`, `INACTIVE`, o con otro `workEndTime` **no** se dispara.
- **CA-02 (CU-02, RN-B06):** *Dado* un empleado con Google conectado y Jira no conectado, *cuando* corre el batch, *entonces* se sincronizan Calendar y Drive y se omite Jira sin error.
- **CA-03 (RN-B03):** *Dado* que el batch ya sincronizó a un usuario, *cuando* la sincronización se repite (p. ej. restart del proceso o doble match por DST), *entonces* no se crean actividades duplicadas.
- **CA-04 (CU-03, RN-B07):** *Dado* un empleado **con** actividad en el día, *cuando* termina su sincronización, *entonces* recibe un email con link al `/dashboard`; *y dado* un empleado **sin** actividad, *entonces* **no** recibe email.
- **CA-05 (RN-B04, E-05):** *Dado* un empleado con actividad cuyo envío de email falla, *cuando* corre el batch, *entonces* la actividad queda igualmente persistida en `daily_activities` y el fallo se registra, sin reintento.
- **CA-06 (CU-02, RN-B05):** *Dado* un lote de N empleados donde la sincronización de uno lanza error, *cuando* corre el batch, *entonces* los demás se procesan igual y el fallo queda logueado.
- **CA-07 (RN-B12):** *Dado* un empleado con `googleReconnectRequired = true`, *cuando* corre el batch, *entonces* se omiten sus fuentes de Google y no se intenta llamar a la API.
- **CA-08 (RN-B11):** *Dado* un empleado con `workStartTime = 21:00` y `workEndTime = 02:00`, *cuando* corre el batch a las 02:00, *entonces* la ventana abarca desde las 21:00 del día anterior hasta las 02:00 de hoy.
- **CA-09 (V-01):** *Dado* un `SCHEDULER_TIMEZONE` inválido o ausente, *cuando* arranca la app, *entonces* el scheduler no inicia y se registra el error (fail-fast).
- **CA-10 (RN-B13, V-05):** *Dado* un empleado con `workEndTime = 09:00`, *cuando* en `SCHEDULER_TIMEZONE` son las 21:00, *entonces* **no** se dispara su sincronización (el match es 24h, no AM/PM).

## 12. Observabilidad

Eventos de log mínimos (Winston, formato estructurado):
- `scheduler.tick` — minuto evaluado, cantidad de usuarios coincidentes.
- `scheduler.user.start` / `scheduler.user.done` — `userId`, conteos por fuente, duración.
- `scheduler.source.skipped` — `userId`, fuente, motivo (no conectado / reconnect requerido).
- `scheduler.user.error` — `userId`, fuente (si aplica), mensaje.
- `scheduler.email.sent` / `scheduler.email.failed` — `userId`, resultado.

## 13. Fuera de alcance

- Generación del informe IA y creación de filas `Report` (on-demand, en otro flujo).
- Contenido enriquecido del email (resumen, adjuntos).
- Re-ejecución manual de la sincronización por el administrador (no existe).
- Soporte multi-instancia / lock distribuido (ADR-004: futuro, acotado a `scheduler/`).
- Catch-up de corridas perdidas.
- Timezone por usuario (hoy: env única; columna por usuario sería evolución futura).

## 14. Cuestiones resueltas

1. **SMTP ausente:** *degradar* — la sincronización se realiza y persiste; el email se omite y se loguea. No bloquea el batch (V-02). (SMTP = servidor de correo saliente que cada empresa self-hosted configura por env.)
2. **`Report` / `totalHours`:** el batch **no** crea Report ni calcula `totalHours`; solo guarda en `daily_activities`. El Report queda para la generación on-demand (§10).
3. **Link del email:** apunta a `FRONTEND_BASE_URL` + `/dashboard`.
4. **Re-ejecución manual (admin):** **diferida** — no existe en este alcance.
5. **Email de aviso:** se mantiene (confirmado), pese a que el MVP original lo listaba como fuera de alcance.
