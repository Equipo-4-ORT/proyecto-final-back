# PLAN — Implementación del Batch Diario de Sincronización

> Plan técnico derivado de la [SPEC funcional](./SPEC-batch-diario-sincronizacion.md) y del [ADR-004](../adr/ADR-004-cron-jobs.md). Describe **cómo** construir el batch: dependencias, archivos, tareas ordenadas y testing.

| | |
|---|---|
| **Feature ID** | F6-01 |
| **Fecha** | 2026-06-06 |
| **Módulo destino** | `src/modules/scheduler/` (+ `src/modules/mail/`) |
| **Depende de** | SPEC y ADR-004 aprobados |

---

## 1. Enfoque

Un **dispatcher** `node-cron` que tickea cada minuto, calcula el `HH:MM` actual en `SCHEDULER_TIMEZONE` (24h), busca los empleados activos cuyo `workEndTime` coincide, y los procesa con un **pool de concurrencia acotada**. Por cada usuario: arma la ventana de su jornada, sincroniza las fuentes conectadas (Calendar, Drive, Jira) reutilizando los servicios existentes, y si hubo actividad le manda un email de aviso con link al dashboard. Todo el fan-out vive en el monolito (in-process), sin infra extra.

El batch **solo escribe en `daily_activities`**; no toca `Report`.

## 2. Stack y piezas reutilizables

| Pieza existente | Uso en el batch |
|---|---|
| `jira.syncForUser(userId, start, end)` | Sync de Jira. Ya refresca token y marca `jiraReconnectRequired`; lanza errores tipados. |
| `drive.persistDriveActivities(userId, token, start, end)` | Sync de Drive (recibe ventana). |
| `calendar.persistCalendarActivities(userId, token, date)` | Sync de Calendar — **a adaptar** a ventana (ver T-04). |
| `getAuthenticatedGoogleClient(token)` / `crypto.decrypt` | Cliente Google + descifrado del refresh token. |
| `mapWithConcurrency` (en `drive-activity.service`) | Patrón del pool de concurrencia — **a extraer** a util compartido (T-03). |
| `activities.service.dayToUTCRange` (luxon) | Modelo para armar la ventana en TZ → UTC (T-02). |
| `requireValidGoogleToken` (middleware) | Modelo para marcar `googleReconnectRequired` ante `invalid_grant`/401 (T-05). |
| `logger` (Winston) | Logs estructurados (RNF-03). |

## 3. Dependencias y configuración nuevas

**npm**
- `node-cron` — scheduler in-process.
- `nodemailer` — envío SMTP.

**Variables de entorno** (cada empresa self-hosted las setea en su `.env`)
| Env | Descripción | Default |
|---|---|---|
| `SCHEDULER_TIMEZONE` | IANA. Interpreta `workEndTime` y arma ventanas. **Validar al inicio** (V-01). | — (requerida) |
| `SCHEDULER_CONCURRENCY` | Máx. usuarios en paralelo en el pool. | `5` |
| `SCHEDULER_ENABLED` | Toggle para apagar el batch (dev/test). | `true` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Servidor de correo saliente. Si faltan → email degrada (V-02). | — |
| `FRONTEND_BASE_URL` | Ya existe. Base del link `/dashboard` del email. | — |

Agregar getters + `validateSchedulerConfig()` en `shared/config/index.js` (mismo patrón de getters ya usado).

## 4. Estructura de archivos

**Nuevos**
```
src/modules/scheduler/
  scheduler.js              ← dispatcher node-cron: start()/stop()/runTick()  (CU-01)
  scheduler.service.js      ← runTick: match de usuarios + pool + orquestación
  userSync.service.js       ← sincroniza las fuentes de un usuario             (CU-02)
  scheduler.window.js       ← buildWorkdayWindow(start,end,fecha,tz) → {start,end} UTC
src/modules/mail/
  mail.service.js           ← transporter nodemailer + sendActivityReadyEmail  (CU-03)
src/shared/utils/
  concurrency.js            ← mapWithConcurrency extraído (T-03)
```
**Modificados**
```
src/server.js                       ← scheduler.start() tras conectar; scheduler.stop() en shutdown
src/shared/config/index.js          ← config + validación del scheduler/mail
src/modules/calendar/calendar.service.js  ← variante por ventana (T-04)
src/modules/drive/drive-activity.service.js ← importar concurrency.js (opcional, DRY)
prisma/schema.prisma                ← @@index([status, role, workEndTime]) + migración
package.json / .env.example         ← deps + envs
```

## 5. Tareas

| ID | Tarea | Archivos | Cubre |
|---|---|---|---|
| **T-01** | **Deps + config.** Instalar `node-cron`/`nodemailer`. Agregar getters de `SCHEDULER_*`/`SMTP_*` y `validateSchedulerConfig()` (valida IANA con luxon, fail-fast). | `package.json`, `shared/config`, `.env.example` | V-01, RNF-06 |
| **T-02** | **Ventana laboral.** `buildWorkdayWindow(workStartTime, workEndTime, fechaRef, tz)` → `{start,end}` en UTC con luxon. Maneja cruce de medianoche: si `end <= start`, `start` cae el día anterior. Valida `start < end`. | `scheduler/scheduler.window.js` | RN-B11, V-04, CA-08 |
| **T-03** | **Pool de concurrencia.** Extraer `mapWithConcurrency` a `shared/utils/concurrency.js`; reapuntar `drive-activity.service` al util. | `shared/utils/concurrency.js`, `drive-activity.service.js` | RN-B09, RNF-04 |
| **T-04** | **Calendar por ventana.** Agregar `persistCalendarActivitiesInWindow(userId, token, start, end)` (reusa `getCalendarEventsForDay`, que ya recibe `timeMin/timeMax`). Deja la función por `date` para el controller actual. | `calendar.service.js` | bound al workday |
| **T-05** | **Orquestador por usuario (CU-02).** `syncUserActivities(user, window)`: si Google conectado y `!googleReconnectRequired` → Calendar(ventana)+Drive; si Jira conectado y `!jiraReconnectRequired` → `jira.syncForUser`. Aísla errores por fuente; ante `invalid_grant`/401 de Google marca `googleReconnectRequired` (helper replicando el middleware). Descifra el token desde el `user` ya cargado. Devuelve conteos. | `scheduler/userSync.service.js` | CU-02, RN-B03/05/06/12, CA-02/06/07 |
| **T-06** | **Email (CU-03).** `mail.service`: transporter nodemailer (singleton lazy) desde `SMTP_*`; `sendActivityReadyEmail(email, {fecha})` con link `FRONTEND_BASE_URL + /dashboard`. Si SMTP no configurado → log + return (degrada). En el scheduler: tras el sync, `count` de actividades en la ventana; si `>0` → enviar; error de envío → log, seguir. | `mail/mail.service.js`, `scheduler.service.js` | CU-03, RN-B04/07/08, CA-04/05 |
| **T-07** | **Dispatcher (CU-01) + ciclo de vida.** `scheduler.js`: registra `cron.schedule('* * * * *', runTick, { timezone })`. `runTick`: `HH:mm` en TZ (24h con luxon `HH:mm`) → `findMany` empleados activos con ese `workEndTime` → pool sobre ellos (T-02+T-05+T-06). `start()`/`stop()`. Guard en memoria de usuarios en curso (E-09). Wire en `server.js`: validar config y `start()` tras `prisma.$connect`; `stop()` en `gracefulShutdown`. | `scheduler/scheduler.js`, `scheduler.service.js`, `server.js` | CU-01, RN-B01/02/13, CA-01/09/10 |
| **T-08** | **Índice en `users`.** `@@index([status, role, workEndTime])` + `prisma migrate dev`. | `prisma/schema.prisma` | §10 perf |
| **T-09** | **Observabilidad.** Logs estructurados: `scheduler.tick`, `user.start/done`, `source.skipped`, `user.error`, `email.sent/failed` (solo `userId`, sin PII). Integrado en T-05/06/07. | (varios) | RNF-03 |
| **T-10** | **Tests Jest.** Un test por CA (ver §7). Mock de prisma y de los services. Espejo de `tests/modules/...`. | `tests/modules/scheduler/*`, `tests/modules/mail/*` | todos los CA |
| **T-11** | **Docs/deploy.** `.env.example`, sección SMTP + `SCHEDULER_TIMEZONE` en README de deploy. Confirmar que el Dockerfile instala deps. | `.env.example`, `README` | — |

**Orden / dependencias:** T-01 → (T-02, T-03, T-04 en paralelo) → T-05 → T-06 → T-07. T-08 y T-11 independientes. T-09 transversal. T-10 a medida que avanza cada pieza.

## 6. Puntos de atención técnicos

1. **Ventana de Calendar (el cambio más importante):** hoy `persistCalendarActivities(userId, token, date)` arma `[date 00:00Z, +1d)` (día UTC completo). El batch necesita la **jornada en `SCHEDULER_TIMEZONE`**. T-04 agrega la variante por ventana; sin esto, Calendar capturaría eventos fuera de la jornada y en TZ equivocada.
2. **Marcado de `googleReconnectRequired`:** los services de Calendar/Drive **no** lo marcan (lo hace el middleware HTTP, que el batch no atraviesa). En T-05 hay que replicar: ante `invalid_grant` / `error.response.status` 400/401, `prisma.user.update({ googleReconnectRequired: true })`. Jira ya lo hace solo.
3. **Descifrado del token:** el dispatcher ya carga el `user` con `refreshToken` en el `findMany`; descifrar inline con `crypto.decrypt` evita la query extra de `getDecryptedRefreshToken`.
4. **`timezone` de node-cron vs match:** como el dispatcher tickea **cada minuto**, la opción `timezone` de `cron.schedule` es secundaria; lo que decide el disparo es calcular `HH:mm` en `SCHEDULER_TIMEZONE` con luxon en formato **24h** (RN-B13 / CA-10). Cuidado con `hh` (12h).
5. **Límite de ventana de Jira:** `syncMaxWindowHours = 24`. La jornada siempre entra (≤ 24h). Único borde: `workStartTime == workEndTime` daría ~24h; definir si se trata como día completo o se omite.
6. **Fail-fast acotado:** si `SCHEDULER_TIMEZONE` es inválida, **no** se arranca el scheduler y se loguea (CA-09); la API sigue sirviendo (no se mata todo el proceso).
7. **Concurrencia anidada:** `SCHEDULER_CONCURRENCY=5` × `ENRICH_CONCURRENCY=10` (Drive) ⇒ hasta ~50 `files.get` simultáneos. Default conservador; ajustar si aparecen rate limits.

## 7. Testing (CA → test)

| Criterio | Test |
|---|---|
| CA-01 | `findMany` matchea EMPLOYEE+ACTIVE con `workEndTime` exacto; ignora ADMIN / INACTIVE / otra hora. |
| CA-02 | `syncUserActivities` con Google sí / Jira no → corre Calendar+Drive, omite Jira sin error. |
| CA-03 | Re-sync no duplica (mock `createMany` con `skipDuplicates`; verificar idempotencia de args). |
| CA-04 | Con actividad → `sendActivityReadyEmail` llamado; sin actividad → no se llama. |
| CA-05 | Email que rechaza → no propaga; el sync ya persistió; se loguea. |
| CA-06 | Lote con un usuario que lanza error → los demás se procesan; error logueado. |
| CA-07 | `googleReconnectRequired = true` → no se llama a la API de Google. |
| CA-08 | `buildWorkdayWindow` con turno 21:00→02:00 → ventana cruza medianoche. |
| CA-09 | `validateSchedulerConfig` con TZ inválida → no arranca scheduler, loguea. |
| CA-10 | `runTick` a las 21:00 no dispara a `workEndTime=09:00` (match 24h). |

Util tests extra: `buildWorkdayWindow` (jornada normal, DST), `mapWithConcurrency` (no excede el límite, preserva orden), `mail.service` (degrada sin SMTP).

## 8. Definition of Done

- [ ] Todas las tareas T-01…T-11 completas.
- [ ] Todos los CA cubiertos con tests; coverage ≥ 80% (umbral del repo).
- [ ] `npm run lint` y `npm test` en verde.
- [ ] `SCHEDULER_TIMEZONE` inválida no rompe la API (solo desactiva el batch).
- [ ] Prueba manual: usuario con `workEndTime` = minuto actual → sincroniza y (si hay actividad) recibe email.
- [ ] `.env.example` y README de deploy actualizados.

## 9. Fuera de alcance (recordatorio)

Generación de `Report` / informe IA, contenido enriquecido del email, re-ejecución manual del admin, multi-instancia, catch-up de corridas perdidas, timezone por usuario. (Ver SPEC §13.)
