# proyecto-final-back

Backend (API REST) del proyecto final de la carrera **Analista en Sistemas** de ORT Belgrano.

Es la plataforma de **registro automático de actividad laboral (AutoLog)**: en lugar de que cada empleado cargue manualmente sus horas, el sistema reconstruye su "huella digital" del día a partir de **Google Calendar**, **Google Drive** y **Jira**, genera un **informe diario asistido por IA** y se lo envía por email al cierre de su jornada. Los administradores gestionan los usuarios y cada empleado puede revisar y ajustar sus actividades y reportes.

---

## Tabla de contenidos

- [Características](#características)
- [Stack tecnológico](#stack-tecnológico)
- [Arquitectura](#arquitectura)
- [Requisitos previos](#requisitos-previos)
- [Puesta en marcha](#puesta-en-marcha)
  - [Opción A — Docker Compose](#opción-a--docker-compose-recomendada)
  - [Opción B — Local (Node + PostgreSQL)](#opción-b--local-node--postgresql)
- [Variables de entorno](#variables-de-entorno)
- [Scripts de npm](#scripts-de-npm)
- [Base de datos (Prisma)](#base-de-datos-prisma)
- [API REST](#api-rest)
- [Autenticación y seguridad](#autenticación-y-seguridad)
- [Batch diario (scheduler)](#batch-diario-scheduler)
- [Módulo de IA](#módulo-de-ia)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Documentación adicional](#documentación-adicional)

---

## Características

- **Login con Google OAuth 2.0** y sesiones basadas en cookies `HttpOnly` (access token JWT de vida corta + refresh token rotativo con detección de reuso).
- **Ingesta de actividad** desde tres fuentes, persistida de forma unificada en `DailyActivity`:
  - **Google Calendar** — reuniones y bloques de calendario.
  - **Google Drive Activity** — creación/edición/renombrado/cambios de permisos de archivos (incluye archivos compartidos).
  - **Jira** (OAuth 2.0 3LO) — worklogs, comentarios, transiciones de estado, asignaciones, creación y edición de issues.
- **Informe diario con IA** mediante patrón Adapter, intercambiable entre **OpenAI** y **Gemini**, con salida JSON validada por esquema.
- **Batch diario** que, al final de la jornada de cada empleado (según su `workEndTime` y timezone), sincroniza su actividad y le avisa por email.
- **Exportación de reportes a Excel**.
- **Gestión de usuarios** (alta, edición, activar/desactivar) y **panel de administración** con control de roles.
- **Endurecimiento de seguridad**: cifrado AES-256-GCM de los refresh tokens en la base, rate limiting, CORS con credenciales, sanitización de logs (anti CRLF-injection) y validación de entrada con Zod.

---

## Stack tecnológico

| Categoría | Tecnología |
|---|---|
| Runtime | **Node.js** `>=20.19` (o `>=22.13`, o `>=24`) |
| Framework HTTP | **Express 5** |
| ORM / Base de datos | **Prisma 6** + **PostgreSQL 15** |
| Autenticación | **jsonwebtoken** (JWT), **cookie-parser** (cookies HttpOnly), **google-auth-library** |
| Integraciones Google | **googleapis** (Calendar, Drive Activity, Sheets) |
| Integración Jira | OAuth 2.0 3LO de Atlassian (cliente HTTP propio) |
| IA | **openai**, **@google/generative-ai** (Gemini) |
| Validación | **zod** |
| Fechas / timezones | **luxon** |
| Scheduler | **node-cron** |
| Email | **nodemailer** (SMTP) |
| Logging | **winston** |
| Rate limiting | **express-rate-limit** |
| Testing | **jest**, **supertest** |
| Calidad de código | **eslint**, **prettier** |
| Contenedores | **Docker**, **Docker Compose** |

---

## Arquitectura

**Monolito modular**: una única app de Express organizada en módulos independientes por dominio. Cada módulo sigue el patrón `routes → controller → service`, y comparte infraestructura transversal (middleware, utilidades, config, acceso a base) en `src/shared`.

```
src/
├── app.js                  # Configura Express: middlewares, CORS, rate limit, montaje de rutas
├── server.js               # Bootstrap: conecta Prisma, levanta el server, arranca el scheduler, shutdown graceful
├── modules/
│   ├── auth/               # Login Google, callback, refresh/logout, bootstrap-admin, cookies y tokens
│   ├── users/             # Settings del usuario (jornada, duración por defecto, solapamientos)
│   ├── admin/             # Alta/edición/estado de usuarios (solo ADMIN)
│   ├── google/            # Verificación de tokens de Google
│   ├── calendar/          # Sync de Google Calendar → DailyActivity
│   ├── drive/             # Sync de Google Drive Activity → DailyActivity
│   ├── jira/              # OAuth 3LO de Jira + sync de actividad → DailyActivity
│   ├── activities/        # CRUD de actividades del usuario
│   ├── reports/           # Generación de reportes + exportación a Excel
│   ├── ai/                # Adapters de IA (OpenAI/Gemini), esquemas, prompts, sanitización
│   ├── timeline/          # Unificación/agrupamiento de actividades
│   ├── scheduler/         # Dispatcher node-cron del batch diario y sync por usuario
│   └── mail/              # Envío de emails vía SMTP
└── shared/
    ├── config/            # Configuración centralizada (puerto, scheduler, SMTP)
    ├── database/          # Cliente Prisma (singleton)
    ├── middleware/        # auth, roles, usuario activo, rate limiter, logging, manejo de errores
    └── utils/             # crypto (AES-GCM), logger, cliente Google, concurrencia, sanitización

prisma/
├── schema.prisma          # Modelos: User, Session, JiraOAuthState, DailyActivity, Report
├── migrations/            # Migraciones versionadas
└── seed.js                # Datos de ejemplo
```

### Modelo de datos (Prisma)

| Modelo | Descripción |
|---|---|
| `User` | Empleado o admin. Guarda jornada laboral, settings, refresh token de Google cifrado y estado de la conexión con Jira/Google. |
| `Session` | Una fila por login activo. Guarda solo el **hash** del refresh token (el valor plano vive en la cookie). Soporta rotación y detección de reuso. |
| `JiraOAuthState` | Estado `state` del flujo OAuth de Jira (vida corta, TTL 10 min). |
| `DailyActivity` | Actividad ingerida de Calendar/Drive/Jira, normalizada (fuente, tipo, tiempos, metadata). |
| `Report` | Informe diario por usuario (horas totales, contenido JSON, URL del Excel, estado `PENDING`/`SENT`). |

---

## Requisitos previos

- **Node.js** `>=20.19` (ver campo `engines` en `package.json`) y **npm**.
- **PostgreSQL 15** (o usar el contenedor que provee Docker Compose).
- **Credenciales de Google Cloud**: una app OAuth 2.0 (Client ID + Secret) con los scopes de Calendar, Drive, Sheets y Docs, y un *redirect URI* apuntando al callback del backend.
- **App OAuth de Atlassian/Jira** (Client ID + Secret + redirect URI) registrada en <https://developer.atlassian.com/console/myapps/>.
- **API key de OpenAI o de Gemini** (según el provider de IA elegido).
- *(Opcional)* Un **servidor SMTP** para los emails del batch diario.

---

## Puesta en marcha

> Antes que nada: copiá el archivo de ejemplo y completá tus valores.
>
> ```bash
> cp .env.example .env
> ```
>
> Mirá la sección [Variables de entorno](#variables-de-entorno) para saber qué significa cada una y cuáles son obligatorias. **La app no arranca** si faltan `ENCRYPTION_KEY`, `ADMIN_SECRET_KEY`, `DATABASE_URL`, `FRONTEND_BASE_URL` o las credenciales de Jira (`JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`), porque se validan al iniciar (*fail-fast*).

### Opción A — Docker Compose (recomendada)

Levanta la base PostgreSQL, la API y (opcionalmente) el frontend en un solo comando.

```bash
# 1. Completá el .env (con POSTGRES_HOST=db, que es el nombre del servicio de la base)
# 2. Build + up
docker compose up --build
```

Esto levanta tres servicios:

- **`db`** — PostgreSQL 15 con healthcheck y volumen persistente (`pgdata`), expuesto en `localhost:5432`.
- **`app`** — la API en `localhost:3000`. El `DATABASE_URL` se arma automáticamente a partir de las variables `POSTGRES_*`.
- **`frontend`** — se construye desde el repo hermano `../proyecto-final-front` y se sirve en `localhost:80`.

> Si solo querés el backend (sin clonar el frontend), levantá únicamente esos servicios:
>
> ```bash
> docker compose up --build app db
> ```

**Aplicar migraciones y seed** (la primera vez, una vez que los contenedores están arriba):

```bash
docker compose exec app npx prisma migrate deploy   # aplica las migraciones existentes
docker compose exec app npm run db:seed             # (opcional) datos de ejemplo
```

### Opción B — Local (Node + PostgreSQL)

```bash
# 1. Instalar dependencias (el postinstall corre `prisma generate`)
npm install

# 2. Configurar el .env, con DATABASE_URL apuntando a tu Postgres local, por ejemplo:
#    DATABASE_URL=postgresql://usuario:password@localhost:5432/proyecto_final

# 3. Crear el esquema en la base y generar el cliente Prisma
npm run db:migrate

# 4. (opcional) Cargar datos de ejemplo
npm run db:seed

# 5. Levantar en modo desarrollo (con recarga automática)
npm run dev
# …o en modo producción:
npm start
```

Verificá que está corriendo:

```bash
curl http://localhost:3000/health
# { "status": "OK", "timestamp": "..." }
```

---

## Variables de entorno

Todas las variables se definen en `.env` (ver `.env.example` como plantilla). La columna **Req.** indica si es obligatoria para arrancar/operar.

### App

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `NODE_ENV` | No | `development` | Entorno de ejecución (`development` / `production` / `test`). |
| `PORT` | No | `3000` | Puerto HTTP de la API. |
| `LOG_LEVEL` | No | `info` | Nivel de winston (`error`, `warn`, `info`, `http`, `debug`). |

### PostgreSQL

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `POSTGRES_USER` | Sí¹ | — | Usuario de la base (lo usa Docker Compose). |
| `POSTGRES_PASSWORD` | Sí¹ | — | Contraseña de la base. |
| `POSTGRES_DB` | Sí¹ | — | Nombre de la base. |
| `POSTGRES_HOST` | Sí¹ | `db` | Host de la base. Con Docker Compose debe ser `db`; en local, `localhost`. |
| `POSTGRES_PORT` | Sí¹ | `5432` | Puerto de la base. |
| `DATABASE_URL` | **Sí** | — | URL completa que usa Prisma: `postgresql://USER:PASS@HOST:PORT/DB`. En Docker Compose se arma automáticamente desde las `POSTGRES_*`. |

> ¹ Las `POSTGRES_*` las consume Docker Compose para crear la base y construir `DATABASE_URL`. Si corrés en local contra una Postgres ya existente, alcanza con setear `DATABASE_URL`.

### Google OAuth

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `GOOGLE_CLIENT_ID` | **Sí** | — | Client ID de la app web de Google Cloud. |
| `GOOGLE_CLIENT_SECRET` | **Sí** | — | Client secret de la app de Google. |
| `GOOGLE_REDIRECT_URI` | **Sí** | `http://localhost:3000/auth/google/callback` | Redirect URI del callback de login. Debe coincidir **exactamente** con el registrado en Google Cloud. |

### Cifrado

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `ENCRYPTION_KEY` | **Sí** | — | Clave AES-256-GCM para cifrar refresh tokens en la base. **Exactamente 64 caracteres hex (32 bytes)**. Generar con `openssl rand -hex 32`. La app falla al iniciar si es inválida. |

### Admin / bootstrap

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `ADMIN_SECRET_KEY` | **Sí** | — | Clave que habilita crear el primer ADMIN (`POST /auth/bootstrap-admin`) y asignar el rol ADMIN. La app falla al iniciar si falta. Generar con `openssl rand -hex 32`. |
| `ADMIN_KEY_HEADER` | No | `X-Admin-Key` | Header HTTP por el que el cliente envía la clave de admin. |

### Jira (OAuth 2.0 3LO)

Cada despliegue registra su propia app OAuth en <https://developer.atlassian.com/console/myapps/>.

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `JIRA_CLIENT_ID` | **Sí** | — | Client ID de la app OAuth de Atlassian. |
| `JIRA_CLIENT_SECRET` | **Sí** | — | Client secret de la app OAuth de Atlassian. |
| `JIRA_REDIRECT_URI` | **Sí** | `http://localhost:3000/api/jira/auth/callback` | Redirect URI del callback de Jira. Debe coincidir **exactamente** con el registrado en la app. |
| `JIRA_SCOPES` | No | `read:jira-work read:jira-user read:me offline_access` | Scopes solicitados a Atlassian. |
| `JIRA_REQUEST_TIMEOUT_MS` | No | `10000` | Timeout de las requests a la API de Jira. |
| `JIRA_SYNC_MAX_WINDOW_HOURS` | No | `24` | Ventana máxima (en horas) de una sincronización de Jira. |

### Frontend / CORS

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `FRONTEND_BASE_URL` | **Sí** | `http://localhost:5173` | Base del frontend. Se usa como `origin` permitido por CORS (con credenciales) y para construir las redirecciones post-callback. |

### Auth — JWT y cookies

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `JWT_ACCESS_SECRET` | **Sí**² | — | Secret para firmar el access token. Generar con `openssl rand -hex 64`. |
| `JWT_REFRESH_SECRET` | No | — | Reservado a futuro (hoy el refresh es opaco, no JWT). |
| `JWT_ACCESS_TTL` | No | `15m` | Vida del access token. |
| `COOKIE_DOMAIN` | No | *(vacío)* | Dominio de las cookies. Vacío en localhost. |
| `COOKIE_SECURE` | No | `false` | `true` en producción (HTTPS). |
| `COOKIE_SAMESITE` | No | `lax` | `lax` si front y back son same-site; `none` (con `COOKIE_SECURE=true`) si están en dominios distintos. |

> ² Durante la migración, el código acepta `JWT_SECRET` como alias si `JWT_ACCESS_SECRET` no está definido.

### Módulo de IA

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `AI_PROVIDER` | Sí³ | `openai` | Provider de IA: `openai` o `gemini`. |
| `OPENAI_API_KEY` | Sí³ | — | API key de OpenAI (si `AI_PROVIDER=openai`). |
| `GEMINI_API_KEY` | Sí³ | — | API key de Gemini (si `AI_PROVIDER=gemini`). |

> ³ Solo hace falta la API key del provider elegido. La generación de informes con IA no funciona sin ella.

### Batch diario (scheduler)

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `SCHEDULER_TIMEZONE` | Sí⁴ | — | Timezone IANA para interpretar `workEndTime` y armar las ventanas (ej: `America/Argentina/Buenos_Aires`). |
| `SCHEDULER_CONCURRENCY` | No | `5` | Máximo de usuarios sincronizados en paralelo. |
| `SCHEDULER_ENABLED` | No | `true` | `false` desactiva el batch (útil en dev/test). |

> ⁴ Requerida **para que el batch arranque**. Si es inválida o ausente, el batch no corre pero la API sigue funcionando con normalidad.

### Email (SMTP)

Opcional. Si no se configura (`SMTP_HOST` o `SMTP_FROM` vacíos), el batch sincroniza igual y solo omite el envío del email.

| Variable | Req. | Default | Descripción |
|---|:---:|---|---|
| `SMTP_HOST` | No | — | Host del servidor de correo saliente. |
| `SMTP_PORT` | No | `587` | Puerto SMTP. |
| `SMTP_SECURE` | No | `false` | `true` para SMTPS (puerto 465). |
| `SMTP_USER` | No | — | Usuario SMTP. |
| `SMTP_PASS` | No | — | Contraseña SMTP. |
| `SMTP_FROM` | No | — | Dirección remitente (ej: `"AutoLog <no-reply@empresa.com>"`). |

---

## Scripts de npm

| Script | Comando | Descripción |
|---|---|---|
| `npm start` | `node src/server.js` | Levanta la API en modo producción. |
| `npm run dev` | `nodemon src/server.js` | Levanta la API con recarga automática. |
| `npm run lint` | `eslint src/` | Corre el linter sobre `src/`. |
| `npm test` | `jest --runInBand` | Corre la suite de tests en serie. |
| `npm run test:watch` | `jest --watch --runInBand` | Tests en modo watch. |
| `npm run test:coverage` | `jest --coverage --runInBand` | Tests con reporte de cobertura (umbral 80%). |
| `npm run db:migrate` | `prisma migrate dev` | Crea/aplica migraciones en desarrollo y regenera el cliente. |
| `npm run db:seed` | `prisma db seed` | Carga datos de ejemplo (`prisma/seed.js`). |
| `npm run db:studio` | `prisma studio` | Abre Prisma Studio (UI para inspeccionar la base). |
| `npm run db:reset` | `prisma migrate reset` | Borra la base, reaplica migraciones y corre el seed. |

> El `postinstall` ejecuta `prisma generate` automáticamente tras `npm install`.

---

## Base de datos (Prisma)

- El esquema vive en [`prisma/schema.prisma`](prisma/schema.prisma) y las migraciones en `prisma/migrations/`.
- **Desarrollo**: `npm run db:migrate` aplica cambios y regenera el cliente.
- **Producción / contenedores**: `npx prisma migrate deploy` aplica las migraciones existentes sin generar nuevas.
- Para inspeccionar datos a mano: `npm run db:studio`.

---

## API REST

Base URL por defecto: `http://localhost:3000`. Respuestas en JSON. La autenticación viaja en la cookie `HttpOnly` `access_token` (no en header `Authorization`).

**Rate limiting:** `/auth` → 20 requests / 15 min; `/api/*` → 200 requests / 15 min.

### Salud

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/health` | — | Health check. |

### Autenticación — `/auth`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/auth/google` | — | Redirige al consentimiento de Google. |
| `GET` | `/auth/google/callback` | — | Callback de Google: crea sesión, setea cookies y redirige al front. |
| `POST` | `/auth/refresh` | cookie refresh | Rota el refresh token y emite un nuevo access token. |
| `POST` | `/auth/logout` | cookie refresh | Revoca la sesión actual y limpia las cookies. |
| `GET` | `/auth/me` | access | Devuelve el usuario actual (revalidado contra la base). |
| `POST` | `/auth/bootstrap-admin` | `X-Admin-Key` | Crea el primer ADMIN (falla si ya existe uno). |

### Usuarios — `/api/users`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/users/me/settings` | access | Devuelve los settings del usuario. |
| `PUT` | `/api/users/me/settings` | access | Actualiza jornada, duración por defecto y solapamientos. |

### Administración — `/api/admin` *(solo ADMIN)*

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/admin/users` | Da de alta un usuario. |
| `GET` | `/api/admin/users` | Lista los usuarios. |
| `PATCH` | `/api/admin/users/:id` | Edita un usuario. |
| `PATCH` | `/api/admin/users/:id/status` | Activa/desactiva un usuario. |

### Actividades — `/api/activities` *(rol EMPLOYEE)*

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/activities` | Lista las actividades del usuario. |
| `POST` | `/api/activities` | Crea una actividad. |
| `PUT` | `/api/activities/:id` | Edita una actividad. |
| `DELETE` | `/api/activities/:id` | Elimina una actividad. |

### Reportes — `/api/reports`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/reports` | access | Lista los reportes del usuario (paginado). |
| `POST` | `/api/reports/generate` | access | Genera el informe (con IA) y lo exporta a Excel. |

### Sincronización de fuentes *(rol EMPLOYEE)*

| Método | Ruta | Requiere | Descripción |
|---|---|---|---|
| `POST` | `/api/calendar/sync` | token Google válido | Sincroniza eventos de Google Calendar. |
| `POST` | `/api/drive/sync` | token Google válido | Sincroniza actividad de Google Drive. |
| `GET` | `/api/jira/auth` | access | Devuelve la URL para iniciar la conexión con Jira. |
| `GET` | `/api/jira/auth/callback` | `state` OAuth | Callback de Jira (público, autorizado por `state`). |
| `GET` | `/api/jira/status` | access | Estado de la conexión con Jira. |
| `DELETE` | `/api/jira/connection` | access | Desconecta Jira (revoca el refresh token). |
| `POST` | `/api/jira/sync` | access | Sincroniza la actividad de Jira. |

---

## Autenticación y seguridad

- **Cookies HttpOnly**: el access token (JWT, ~15 min) y el refresh token viajan en cookies `HttpOnly`, no en la URL ni accesibles por JavaScript (mitiga robo por XSS). El JWT no aparece en historial, logs ni `Referer`.
- **Refresh tokens rotativos**: cada refresh emite un token nuevo y revoca el anterior. Si reaparece un refresh ya revocado, se interpreta como robo y se **revocan todas las sesiones** del usuario.
- **Cifrado en reposo**: los refresh tokens de Google y de Jira se guardan cifrados con **AES-256-GCM** (`src/shared/utils/crypto.js`).
- **Control de acceso por capas**: `authMiddleware` (token válido) → `requireActiveUser` (existe y está activo, revalida contra la base) → `requireRole` (rol vigente).
- **CORS con credenciales**: `origin` explícito (`FRONTEND_BASE_URL`, nunca `*`) + `credentials: true`.
- **Rate limiting** sobre `/auth` y `/api`.
- **Validación de entrada** con Zod y **sanitización de logs** (anti CRLF / log-injection).
- **Defensa SSRF** en Jira: validación del `cloudId` antes de interpolarlo en URLs.

---

## Batch diario (scheduler)

Un dispatcher de **node-cron** corre cada minuto y, para cada empleado cuya jornada termina en ese minuto (según su `workEndTime` interpretado en `SCHEDULER_TIMEZONE`):

1. Sincroniza su actividad de las fuentes conectadas.
2. Genera/actualiza su informe diario.
3. Le envía un email avisando que su informe está listo (si SMTP está configurado).

Las sincronizaciones se ejecutan en paralelo con un límite de `SCHEDULER_CONCURRENCY`. El batch se desactiva con `SCHEDULER_ENABLED=false` y degrada con gracia: si `SCHEDULER_TIMEZONE` es inválida no arranca el batch, pero la API sigue funcionando; si SMTP no está configurado, sincroniza igual y omite el email.

---

## Módulo de IA

Genera el informe diario a partir de las actividades del usuario usando un **patrón Adapter** con registry de providers (`src/modules/ai/`):

- **Providers soportados**: `openai` y `gemini` (se elige con `AI_PROVIDER`).
- **Salida estructurada**: JSON estricto validado con **Zod** antes de persistir.
- **Sanitización** del contexto que se manda al modelo y respeto del flag `avoidOverlaps` del usuario al validar solapamientos.

Para cambiar de provider basta con setear `AI_PROVIDER` y la API key correspondiente; no hay que tocar código.

---

## Testing

```bash
npm test              # suite completa (en serie)
npm run test:coverage # con cobertura (umbral global del 80%)
```

- Framework: **Jest** + **Supertest**, con los tests bajo `tests/`.
- `tests/globalSetup.js` y `tests/setupEnv.js` inyectan variables y mocks (incluidas API keys de prueba) para que el pipeline no dependa de credenciales reales.
- La cobertura exige **80%** en líneas, ramas, funciones y statements (config en `package.json`).

---

## CI/CD

Workflows de GitHub Actions (`.github/workflows/`):

- **`ci.yml`** — corre `lint` y `test` en cada PR a `main`/`develop`, y un job de **cobertura** que exige el 80%.
- **`codeql.yml`** — análisis estático de seguridad (CodeQL) para JavaScript.
- **`security.yml`** — escaneo de secretos con **gitleaks**.
- **`pr-guard.yml`** — validaciones sobre los pull requests.

---

## Documentación adicional

- **Changelog**: [`CHANGELOG.md`](CHANGELOG.md) — historial detallado de cambios por versión.
- **Especificaciones y planes**: carpeta [`docs/specs/`](docs/specs/) — specs funcionales y técnicas (batch diario, reporte Excel en Drive) y plantillas.

---

> Proyecto académico — carrera Analista en Sistemas, ORT Belgrano.
