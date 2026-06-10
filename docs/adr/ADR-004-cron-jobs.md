# ADR-004: Estrategia para el batch diario (Cron Jobs en Node.js)

- **Estado:** Aceptado
- **Fecha:** 2026-05-26
- **Revisado:** 2026-06-06 — se refinan los criterios para habilitar la implementación del batch diario: distribución **self-hosted** (OS del host desconocido), **fan-out por usuario** concentrado en la misma hora, y **envío de email** al cierre de cada sincronización.

---

## Contexto

El proyecto requiere un **batch diario** que sincroniza, para cada empleado, su actividad de **Google Calendar**, **Google Drive** y **Jira**, la persiste en la base de datos y al terminar le **envía un email** con su reporte. A futuro pueden sumarse otros jobs de mantenimiento.

Fue necesario elegir la herramienta con la que se implementarán estos jobs. La decisión se toma considerando el equipo pequeño, el alcance del proyecto y, sobre todo, las siguientes características concretas del despliegue y de la tarea:

- **Distribución self-hosted:** cada empresa despliega su propia instancia. **No controlamos el sistema operativo del host** ni podemos asumir que haya un sysadmin configurando el servidor. Cualquier dependencia de infraestructura recae sobre el cliente que se autohospeda.
- **Aplicación dockerizada:** el `docker-compose` levanta `frontend`, `app` (Node.js/Express) y `db` (PostgreSQL con Prisma ORM). **No hay Redis.**
- **Una sola instancia** del contenedor `app` (coherente con ADR-002: monolito modular, un único proceso desplegable).
- **Patrón fan-out:** el batch recorre **todos los usuarios con rol `EMPLOYEE` y estado `ACTIVE`** y, uno por uno, invoca los servicios de back ya existentes (`calendar.persistCalendarActivities`, `drive.persistDriveActivities`, `jira.syncForUser`), que están diseñados *caller-agnostic* (reciben `userId` + ventana de tiempo).
- **Disparo por hora configurada por el usuario:** cada usuario define a qué hora corre su sincronización; el batch debe respetarla.
- **Concentración temporal (thundering herd):** se espera que casi todos los usuarios compartan casi la misma hora. En el pico, **cientos de sincronizaciones** —cada una con varias llamadas a APIs externas sujetas a *rate limits* (Google, Jira)— caen prácticamente juntas.
- **Frecuencia baja por usuario:** una vez al día. La pérdida de una corrida por restart del proceso no es crítica: el día siguiente la recupera por idempotencia.

Las opciones evaluadas fueron:

1. **`node-cron`** — librería *in-process* que ejecuta tareas en el mismo proceso Node.js según una expresión cron.
2. **`bullmq`** — librería de cola de trabajos con persistencia en Redis, soporte de reintentos y workers separados.
3. **Cron del sistema operativo** — `crontab` en Linux / Task Scheduler en Windows, que invoca scripts Node.js externos al proceso de la aplicación.

---

## Decisión

Se adopta **`node-cron`** como scheduler, implementado como un **dispatcher que tickea cada minuto** y delega el fan-out a un **pool de trabajo en proceso con concurrencia acotada**.

Los jobs se registran al inicializar la aplicación dentro del proceso Node.js/Express, comparten el contexto de la app (pool de Prisma, logger de Winston, servicios existentes) y se organizan como un módulo interno (`src/modules/scheduler/`).

El detalle del flujo está en [Modelo de ejecución](#modelo-de-ejecución).

---

## Justificación

### Comparativa técnica (criterios refinados)

| Criterio | `node-cron` | `bullmq` | Cron del SO |
|---|---|---|---|
| Infraestructura adicional | Ninguna | **Redis obligatorio** | Ninguna |
| Carga operativa para el self-hoster | Mínima (es una dependencia npm) | Alta (cada cliente instala y opera Redis) | Alta (configurar cron por host/OS) |
| Portabilidad sobre host desconocido (dockerizado) | **Total** (corre dentro del contenedor Node) | Total en Node, pero arrastra Redis | **Baja** (depende del OS del host) |
| Complejidad de setup | Baja | Alta | Media |
| Comparte contexto de la app | Sí (in-process) | Parcial (workers separados) | No (proceso nuevo) |
| Aptitud para fan-out con rate limits | Media (concurrencia en código) | Alta (workers + limiter nativos) | Baja |
| Control de concurrencia / cola | Manual (pool en código) | Nativo | No |
| Reintentos automáticos | No (manual) | Sí (backoff exponencial) | No |
| Persistencia de jobs | No | Sí (Redis) | No |
| Soporte de timezones | Sí | Sí | Depende del OS |
| Adecuado para el volumen del proyecto | Sí | Sí (sobredimensionado) | Sí |

### Por qué la distribución self-hosted es decisiva

Este es el criterio que más pesa y el que más cambió respecto de la versión original del ADR:

- **`node-cron` es OS-agnóstico por estar dentro del contenedor.** Corre en el mismo proceso Node que ya despliega el cliente; no importa si el host es Linux, Windows o lo que sea. Levanta con `docker-compose up`, igual que el resto de la app.
- **El cron del SO es inviable para un producto self-hosted.** Su sintaxis y comportamiento difieren entre Linux, macOS y Windows, y en Docker el daemon de cron debe configurarse a mano y no es el proceso principal del contenedor. No podemos exigirle a cada empresa que configure un crontab/Task Scheduler en su host.
- **`bullmq` traslada una carga operativa que no podemos imponer.** Obliga a cada cliente que se autohospeda a instalar, operar y mantener un Redis solo para correr un job diario. Eso contradice directamente la decisión de mínima complejidad operacional del ADR-002.

### Por qué `node-cron` a pesar del fan-out (el caso más fuerte de `bullmq`)

Hay que decirlo con honestidad: **el fan-out concentrado en una misma hora es exactamente el escenario donde `bullmq` brilla** —cola con persistencia, workers con concurrencia configurable, *rate limiting* y reintentos con backoff, todo de fábrica—. Si Redis ya estuviera en la infraestructura, sería la opción natural.

Aun así se mantiene `node-cron` porque:

- El costo de `bullmq` (Redis en cada despliegue de cada cliente) supera a su beneficio para una tarea de **frecuencia diaria y baja criticidad de volumen**.
- Las capacidades que aporta `bullmq` para el fan-out **se resuelven en código** con piezas que ya existen o son sencillas: un pool de concurrencia acotada (el helper `mapWithConcurrency` ya está en `drive-activity.service`), aislamiento de errores por usuario, e idempotencia a nivel actividad y a nivel reporte (ver más abajo).
- La recuperación ante fallos no necesita reintentos automáticos: se decidió **aislar, loguear y seguir**, con reintento manual vía endpoint y recuperación natural en el ciclo del día siguiente gracias a la idempotencia.

Si el volumen, la criticidad o el requisito de confiabilidad crecen, la migración a `bullmq` queda **acotada al módulo `scheduler/`** sin impactar el resto del sistema.

### Por qué no el cron del SO

Además de la portabilidad nula ya descrita (decisiva para self-hosted), ejecuta cada job como un proceso Node.js independiente:

- **Sin contexto compartido:** cada ejecución abre su propia conexión a la BD y su propio logger, en lugar de reutilizar el pool y los servicios existentes.
- **Desacoplamiento del código:** los jobs viven fuera del proyecto como scripts sueltos, no se benefician de la estructura modular ni se testean con Jest como el resto.

---

## Modelo de ejecución

Este es el flujo que habilita la implementación del batch diario:

1. **Dispatcher.** Un único job `node-cron` con expresión `* * * * *` (cada minuto). La timezone de referencia es **única para todo el despliegue**, vía la env `SCHEDULER_TIMEZONE` (identificador IANA, p. ej. `America/Argentina/Buenos_Aires`). Se valida al iniciar la app; si falta o es inválida, el batch no arranca (*fail-fast*).
2. **Match por hora.** En cada tick se calcula el `HH:MM` actual en `SCHEDULER_TIMEZONE` (con luxon, que ya es dependencia) y se consultan los usuarios `EMPLOYEE` + `ACTIVE` cuya hora configurada (`workEndTime`) coincide con ese `HH:MM`. `workEndTime` se guarda como wall-clock `"HH:MM"` **sin zona** en la BD, por eso se lo interpreta en `SCHEDULER_TIMEZONE`. (Disparo elegido: *dispatcher cada minuto*, frente a barrido por hora —resolución de 1 h— o un cron por usuario —pesado y frágil ante cambios de horario—.)
3. **Pool acotado.** Los usuarios matcheados se procesan con **concurrencia limitada** (configurable por env, p. ej. `SCHEDULER_CONCURRENCY`) para respetar los *rate limits* de Google y Jira. El pool es compartido y en memoria: como hay **una sola instancia**, acota la concurrencia total aun si dos ticks se solapan, y no requiere lock distribuido.
4. **Sincronización por usuario.** La ventana `[inicio, fin)` del día se arma a partir de la jornada del usuario (`workStartTime`/`workEndTime`) interpretada en `SCHEDULER_TIMEZONE` y convertida a UTC (mismo patrón que `dayToUTCRange` en `activities.service`). Con esa ventana se invoca, para cada usuario: Calendar → Drive → Jira (servicios existentes) y, al terminar, **email** con el reporte a su dirección.
5. **Aislamiento de errores.** El fallo de un usuario (API caída, token expirado, etc.) se **loguea y no aborta el batch**; el resto sigue. El usuario fallido queda registrado para reintento.
6. **Idempotencia en dos niveles.**
   - *Actividad:* `@@unique([userId, source, externalId])` + `skipDuplicates` evita duplicar actividades.
   - *Batch/reporte:* `@@unique([userId, reportDate])` en `Report` sirve de ancla para no reprocesar ni reenviar el email del mismo usuario el mismo día.
7. **Recuperación.** No hay reintentos automáticos: la recuperación es **manual** (endpoint admin de re-ejecución por usuario) o **natural** (el ciclo del día siguiente recupera por idempotencia).

---

## Consecuencias

**Positivas:**
- Cero overhead de infraestructura: no se necesita Redis ni configuración de cron en el host. Coherente con el modelo self-hosted y con ADR-002.
- Los jobs son parte del monolito: se testean (Jest), se loggean (Winston) y se despliegan junto con el resto de la app.
- El fan-out, la concurrencia y la idempotencia se controlan con código propio y piezas ya existentes.
- El equipo no necesita aprender una tecnología de colas nueva.

**Negativas:**
- **Asume una sola instancia.** Si en el futuro se escala el contenedor `app` a múltiples réplicas, `node-cron` dispararía en cada una y se duplicarían sincronizaciones y emails. Requeriría un lock en BD (advisory lock) o leader-election.
- **Sin reintentos ni cola nativos:** la robustez del fan-out (concurrencia, recuperación) es responsabilidad del código del módulo `scheduler/`.
- Si el proceso Node.js se reinicia mientras el batch corre, la corrida se interrumpe sin reanudar (se recupera al día siguiente por idempotencia).
- Sin dashboard ni historial de ejecuciones fuera del logger.

**Mitigaciones:**
- **Single-instance** documentado como restricción explícita; al escalar, la migración a lock/`bullmq` queda acotada a `scheduler/`.
- **Thundering herd** mitigado con el pool de concurrencia acotada (respeta rate limits de Google/Jira).
- **Idempotencia** a nivel actividad y reporte: re-ejecutar no duplica datos ni reenvía emails.
- **Aislamiento + reintento manual:** un fallo por usuario no tumba el batch; se reintenta vía endpoint o en el ciclo siguiente.
- Los logs de Winston son suficientes para auditar ejecuciones en el alcance del proyecto.

---

## Pendientes de implementación (fuera del alcance de la decisión, pero necesarios)

- **Timezone del batch — resuelto.** Se usa una **env única `SCHEDULER_TIMEZONE`** (IANA) para todo el despliegue, coherente con el MVP self-hosted single-company. El modelo `User` no tiene columna de timezone (verificado: `workEndTime` se guarda como `"HH:MM"` sin zona, y la TZ que usa el módulo `activities` la provee el front por query param, no la BD). Si a futuro los empleados abarcan distintas zonas, se agregaría una columna `timezone` por usuario. Falta: agregar `SCHEDULER_TIMEZONE` a `shared/config` con validación al inicio.
- **Hora de disparo.** Se basa en `workEndTime` (la jornada ya existente). Si se quisiera una hora de sync independiente de la jornada, se agregaría un campo `syncTime` dedicado.
- **Dependencia de email.** Aún no hay librería de envío (p. ej. `nodemailer`) ni configuración SMTP; el modelo `Report` (`status` PENDING/SENT, `sentAt`) ya lo anticipa.
- **Endpoint admin de re-ejecución manual** por usuario, para la recuperación de fallos.
