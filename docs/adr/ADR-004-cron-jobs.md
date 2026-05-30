# ADR-004: Estrategia para Cron Jobs en Node.js

- **Estado:** Aceptado
- **Fecha:** 2026-05-26

---

## Contexto

El proyecto requiere ejecutar tareas programadas de forma periódica: sincronización de actividades desde la Drive Activity API, generación de reportes, y potencialmente otros jobs de mantenimiento a futuro. Estas tareas son de baja frecuencia (diaria o semanal) y de baja criticidad operacional en términos de volumen.

Fue necesario elegir la herramienta con la que se implementarán estos jobs, considerando la simplicidad del equipo y la infraestructura existente (monolito modular, PostgreSQL, sin Redis).

Las opciones evaluadas fueron:

1. **`node-cron`** — librería in-process que ejecuta tareas en el mismo proceso Node.js según una expresión cron.
2. **`bullmq`** — librería de cola de trabajos con persistencia en Redis, soporte de reintentos y workers separados.
3. **Cron del sistema operativo** — `crontab` en Linux / Task Scheduler en Windows, que invoca scripts Node.js externos al proceso de la aplicación.

---

## Decisión

Se adopta **`node-cron`** como mecanismo de tareas programadas.

Los jobs se registran al inicializar la aplicación dentro del proceso Node.js/Express, comparten el contexto de la app (conexión a BD, logger, servicios existentes) y se organizan como un módulo interno (`src/modules/scheduler/`).

---

## Justificación

### Comparativa técnica

| Criterio | `node-cron` | `bullmq` | Cron del SO |
|---|---|---|---|
| Infraestructura adicional | Ninguna | Redis obligatorio | Ninguna |
| Complejidad de setup | Baja | Alta | Media |
| Persistencia de jobs | No | Sí (Redis) | No |
| Reintentos automáticos | No (manual) | Sí (exponential backoff) | No |
| Comparte contexto de la app | Sí (in-process) | Parcial (workers separados) | No (proceso nuevo) |
| Soporte de timezones | Sí | Sí | Depende del SO |
| Portabilidad | Total (Node.js) | Total (Node.js + Redis) | Baja (Linux ≠ Windows ≠ Docker) |
| Descargas semanales (npm) | ~2.6M | ~5.9M | N/A |
| Versión actual | 4.2.1 | 5.77.3 | N/A |
| Adecuado para volumen bajo | Sí | Sí (sobredimensionado) | Sí |

### Por qué no `bullmq`

BullMQ es la opción más robusta para producción a escala, pero introduce una dependencia de infraestructura que el proyecto no tiene ni justifica: Redis. Agregar Redis solo para ejecutar dos o tres jobs de baja frecuencia contradice directamente la decisión de arquitectura del ADR-002 (monolito modular con mínima complejidad operacional). Sus ventajas diferenciales (persistencia, reintentos automáticos, workers distribuidos) son irrelevantes para jobs que corren una vez por día y cuya pérdida por restart del proceso no representa un problema crítico.

### Por qué no el cron del SO

El cron del sistema operativo ejecuta cada job como un proceso Node.js independiente. Esto tiene tres problemas concretos para este proyecto:

- **Sin contexto compartido:** cada ejecución abre su propia conexión a la base de datos y su propia instancia del logger, en lugar de reutilizar el pool existente.
- **Portabilidad nula:** la sintaxis y el comportamiento difieren entre Linux, macOS y Windows. En Docker, el daemon de cron debe configurarse manualmente y no es el proceso principal del contenedor, lo que complica el manejo del ciclo de vida.
- **Desacoplamiento del código:** los jobs viven fuera del proyecto como scripts sueltos, no se benefician de la estructura modular ni pueden testearse con el mismo framework (Jest) que el resto de la aplicación.

### Por qué `node-cron`

- **Sin infraestructura extra:** se instala como dependencia npm, sin Redis ni daemons externos.
- **Contexto compartido:** los jobs corren en el mismo proceso que Express, por lo que usan el mismo pool de conexiones de Prisma, el mismo logger de Winston y los servicios ya definidos (por ejemplo, `driveService.syncActivities(userId)`).
- **Consistencia con la arquitectura:** un único proceso desplegable, fácil de levantar con `docker-compose up`, coherente con ADR-002.
- **Testeable:** los jobs son funciones comunes de Node.js que pueden importarse y testearse con Jest como cualquier otro servicio.
- **Soporte de timezones:** permite especificar el timezone directamente en la expresión cron, sin conversiones manuales.

La ausencia de persistencia y reintentos automáticos se mitiga con manejo de errores explícito y logging dentro de cada job. Si en el futuro el volumen o la criticidad de los jobs aumenta, la migración a BullMQ está acotada al módulo `scheduler/` sin impactar el resto del sistema.

---

## Consecuencias

**Positivas:**
- Cero overhead de infraestructura: no se necesita Redis ni configuración adicional de Docker.
- Los jobs son parte del monolito, se testean, se loggean y se despliegan junto con el resto de la app.
- Setup mínimo: registrar un job son tres líneas de código.
- El equipo no necesita aprender una nueva tecnología de colas.

**Negativas:**
- Si el proceso Node.js se reinicia mientras un job está corriendo, la tarea se interrumpe sin reanudar.
- No hay cola: si dos ejecuciones se solapan (job lento + siguiente disparo), corren en paralelo sin control nativo.
- Sin dashboard ni visibilidad de historial de ejecuciones fuera del logger.

**Mitigaciones:**
- Cada job debe ser idempotente: re-ejecutarlo no genera datos duplicados (el campo `externalId` de `DailyActivity` ya prevé esto con el `@@unique`).
- Se puede implementar un flag en memoria o en BD para evitar ejecuciones solapadas si fuera necesario.
- Los logs de Winston son suficientes para auditar ejecuciones en el alcance del proyecto.
- Si el proyecto escala a producción real con requisitos de confiabilidad, la migración a BullMQ es localizada al módulo `scheduler/`.
