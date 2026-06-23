# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.0] - 2026-06-23

### Added

#### Integración con Google Calendar

- Módulo Calendar (`src/modules/calendar/`) con `calendar.service.js`, `calendar.controller.js` y `calendar.routes.js`
- Endpoint `POST /api/calendar/sync`: trae los eventos del día del usuario, los filtra y los persiste como `DailyActivity` (`source: 'calendar'`), guardando el `summary` del evento en `title`
- El endpoint espera `startTime`/`endTime` del rango a sincronizar y valida fechas legibles; alineado con el logging y el manejo de errores del módulo Drive

#### Integración con Google Drive Activity

- Módulo Drive (`src/modules/drive/`) con `drive-activity.service.js`, `drive-activity.controller.js` y `drive-activity.routes.js`
- Endpoint `POST /api/drive/sync`: ingiere actividad de Drive vía Drive Activity API (`create`, `edit`, `rename`, `permissionChange`, etc.) y la persiste como `DailyActivity` (`source: 'drive'`) con `fileType` y `title`
- Captura de actividades sobre archivos compartidos (`sharedWithMe`) y archivos dentro de carpetas, además de acciones fuera de la unidad propia del usuario
- Agrupamiento/unificación de actividades de la timeline (`src/modules/timeline/timeline.service.js`)

#### Integración con Jira

- Módulo Jira (`src/modules/jira/`) implementando el flujo OAuth 2.0 3LO de Atlassian con `jira.client.js`, `jira.service.js`, `jira.controller.js`, `jira.routes.js`, `jira.mapper.js`, `jira.constants.js` y `jira.errors.js`
- Endpoints REST bajo `/api/jira`: `GET /auth` (iniciar conexión), `GET /auth/callback` (público, autorizado por `state` de OAuth), `GET /status`, `DELETE /connection` y `POST /sync` (ingesta de worklogs con ventana de fechas configurable)
- Almacenamiento cifrado (AES-256-GCM) del refresh token de Jira y estado de conexión por usuario en el modelo `User` (`jiraCloudId`, `jiraSiteUrl`, `jiraConnectedAt`, `jiraLastSyncAt`, `jiraReconnectRequired`)
- Modelo `JiraOAuthState` para tokens `state` de OAuth de vida corta (TTL 10 minutos, en cascada al borrar el usuario)
- Campo `DailyActivity.externalId` + `@@unique([userId, source, externalId])` y `@@index([userId, source, startTime])` para ingesta idempotente de worklogs de Jira
- Variables de entorno de Jira: `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`, `JIRA_SCOPES`, `JIRA_REQUEST_TIMEOUT_MS`, `JIRA_SYNC_MAX_WINDOW_HOURS` y `FRONTEND_BASE_URL`

#### Generación de informes con IA

- Módulo IA (`src/modules/ai/`) con patrón Adapter + registry de providers: interfaz abstracta (`ai.interface.js`), `adapters/index.js`, esquemas/tipos (`ai.schemas.js`, `ai.types.js`, `ai.output.types.js`), errores (`ai.errors.js`), sanitización de contexto (`ai.sanitize.js`) y prompt compartido (`prompts/summary.prompt.js`)
- Adaptador OpenAI (`adapters/openai.adapter.js`) con salida JSON estricta validada con Zod
- Adaptador Gemini 2.5 (`adapters/gemini.adapter.js`)
- Validación de solapamiento de actividades en los reportes generados por IA (respeta el flag `avoidOverlaps` del usuario)
- Variables de entorno: `AI_PROVIDER` (`openai` | `gemini`), `OPENAI_API_KEY`, `GEMINI_API_KEY`
- ADR-003: registro de decisión del patrón Adapter para la integración de IA

#### Batch diario (scheduler) + notificación por email

- Módulo Scheduler (`src/modules/scheduler/`): dispatcher node-cron que corre cada minuto (`scheduler.js`), `scheduler.service.js` (tick), `scheduler.window.js` (ventanas de sincronización por `workEndTime`/timezone) y `userSync.service.js`
- Sincroniza la actividad de cada empleado al cierre de su jornada y le avisa por email que su informe está listo
- Módulo Mail (`src/modules/mail/mail.service.js`) vía SMTP/Nodemailer; si SMTP no está configurado, el batch sincroniza igual y omite el email
- Utilidad de concurrencia (`src/shared/utils/concurrency.js`) para limitar las sincronizaciones en paralelo
- Variables de entorno: `SCHEDULER_TIMEZONE`, `SCHEDULER_CONCURRENCY`, `SCHEDULER_ENABLED`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

#### CRUD de actividades y reportes

- Módulo Activities (`src/modules/activities/`) con CRUD por usuario: `GET /api/activities`, `POST /api/activities`, `PUT /api/activities/:id`, `DELETE /api/activities/:id` (protegido por rol `EMPLOYEE`)
- Endpoint `POST /api/reports/generate` (con rate limit) y `GET /api/reports`
- Exportación de reportes a Excel (`src/modules/reports/reports.sheet.js`), persistida como `xlsxUrl` en el modelo `Report`
- Reporte v2: el modelo `Report` ahora usa `totalHours`, `content` (JSON) y `sentAt`; estado `SENT` reemplaza a `EDITED`/`APPROVED`

#### Gestión de usuarios y settings

- Panel de administración (`src/modules/admin/`): `POST /api/admin/users` (alta), `GET /api/admin/users`, `PATCH /api/admin/users/:id` (edición) y `PATCH /api/admin/users/:id/status` (activar/desactivar); solo `ADMIN`
- Validaciones estrictas de Zod para email y nombre en alta de usuarios (`admin.validation.js`)
- Settings por usuario: `GET /api/users/me/settings` y `PUT /api/users/me/settings` para `workStartTime`, `workEndTime`, `defaultDuration` y `avoidOverlaps`
- Campos nuevos en `User`: `workStartTime`, `workEndTime`, `defaultDuration` (default 60 min), `avoidOverlaps`, `status` (enum `UserStatus`: `ACTIVE`/`INACTIVE`), `apiKey` y `@@index([status, role, workEndTime])` para el dispatcher del batch

#### Autenticación con cookies HttpOnly

- Modelo `Session` (hash del refresh token, rotación + detección de reuso), helpers `auth.tokens.js` y `auth.cookies.js`, y nuevos endpoints `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`
- Dependencia `cookie-parser` y variables de entorno `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `COOKIE_DOMAIN`, `COOKIE_SECURE`, `COOKIE_SAMESITE`
- Middleware `requireValidGoogleToken` (`src/shared/middleware/`) + utilidades `googleAuthError.js` y `refreshToken.js` para renovar/validar el token de Google antes de llamar a Calendar/Drive, marcando `googleReconnectRequired` cuando el token fue revocado
- Middleware `requireActiveUser` que revalida `role`/`status` contra la DB

#### Infraestructura y dependencias

- Config centralizada (`src/shared/config/index.js`) exponiendo `frontendBaseUrl`, `port`, `nodeEnv` y la config del scheduler
- Dependencias nuevas: `@google/generative-ai`, `googleapis`, `openai`, `zod`, `luxon`, `node-cron`, `nodemailer`, `cookie-parser`
- Script `postinstall` (`prisma generate`) para que el cliente de Prisma se genere automáticamente (incluido en CI/tests)
- Tests corren en serie (`jest --runInBand`) con `globalSetup` y `setupEnv` (mock de API keys para que el pipeline de CI no falle)

### Changed

- **Auth migrada a cookies HttpOnly**: `authMiddleware` lee el access token de `req.cookies.access_token` (antes header `Authorization`); el callback de Google setea cookies y redirige a `/callback` **sin** `?token=` en la URL; `handleGoogleCallback` devuelve el `user` (antes el JWT)
- CORS configurado con `origin` explícito (`FRONTEND_BASE_URL`) + `credentials: true` (antes `cors()` sin opciones)
- `GET /auth/me` pasa por `requireActiveUser` → revalida `role`/`status` contra la DB
- Rate limiting separado: `authLimiter` sobre `/auth` y `apiLimiter` sobre `/api`
- `DailyActivity` ampliado con `title`, `fileType` y `externalId`; comentario de `source` actualizado para incluir `'jira'`; `activityType` documenta acciones reales (`create`, `edit`, `rename`, `permissionChange`, `meeting`, …)
- Jira mapper enriquecido para no perder datos; los tiempos de Jira se interpretan siempre en segundos
- Cálculo de tiempos unificado: traducción horas↔minutos, corrección del `endTime` de actividades y del cálculo de minutos al editar; los tiempos de IA se manejan en UTC
- Títulos de actividad guardados también en `metadata.title`, ajustados según acción + archivo y entrecomillados; deduplicación de actividades cuando ocurren varias acciones en simultáneo
- `Dockerfile` corregido; documentación del proyecto movida a `/documentation`

### Fixed

- El admin ya no puede desactivar su propia cuenta
- Solo los admins pueden crear usuarios; se valida que el usuario logueado sea admin y exista en la DB
- Redirección de error de login unificada (T001) y path de `UnauthorizedUserError` del callback usaba `FRONTEND_URL` (sin definir) → ahora `FRONTEND_BASE_URL`
- Bug que eliminaba y volvía a crear actividades ya guardadas; error de `rename` duplicado; actividades duplicadas en Jira
- Middleware que bloqueaba al frontend
- Migraciones duplicadas/vacías eliminadas; `package.json` y `package-lock.json` sincronizados

### Security

- El JWT deja de viajar en la URL del callback (no más token en historial/logs/`Referer`) y deja de ser accesible por JS (cookie `HttpOnly` → mitiga robo por XSS); CSRF mitigado con `SameSite=Lax`. `User.refreshToken` (refresh de Google) se documenta sin renombrar para no romper el path de Calendar/Drive
- Validación de URLs (`isSafeUrl`) para mitigar links maliciosos en redirecciones
- Validación del token de Google en endpoints autenticados de Google (`requireValidGoogleToken`) y `.gitleaksignore` ajustado para claves de test

## [0.3.0] - 2026-05-17

### Added

- Google OAuth authentication flow: `signInWithGoogle` and `signUpWithGoogle` in `auth.service.js`, issuing JWT access tokens on success
- JWT-based access tokens (`jsonwebtoken`) for authenticated sessions
- Encrypted refresh token storage: AES encrypt/decrypt utilities in `src/shared/utils/crypto.js` applied when persisting refresh tokens via `upsertGoogleUser`
- Role assignment with validation key: first-user bootstrap assigns `ADMIN` role when a shared key is provided; subsequent users receive `EMPLOYEE`
- `requireRole` middleware for role-based route protection
- `authMiddleware` for JWT verification on protected routes (`src/shared/middleware/authMiddleware.js`)
- `authErrorHandler` middleware for structured authentication/authorization error responses
- Users module: `src/modules/users/users.service.js` and `src/modules/users/users.routes.js`
- Rate limiting middleware (`src/shared/middleware/rateLimiter.js`) applied to public endpoints and user routes
- ADR-002: Modular monolith architecture decision record (`docs/adr/ADR-002-arquitectura-monolito-modular.md`)
- ADR-003: Adapter pattern for AI integration decision record (`docs/adr/ADR-003-adapter-pattern-ia.md`)
- Comprehensive test suite: `auth.controller.test.js`, `auth.service.test.js`, `google.service.test.js`, `users.service.test.js`, `authMiddleware.test.js`, `authErrorHandler.test.js`, `rateLimiter.test.js`, `requireRole.test.js`, `crypto.test.js`
- `.gitleaksignore` to suppress false-positive secret detection on test-only keys

### Changed

- User service refactored: aligned `fullName` field with database schema, added `client_id` validation, improved sanitized logging and error stack propagation
- Crypto utility refactored to use arrow functions; `.env.example` updated with new required variables (`JWT_SECRET`, `REFRESH_TOKEN_KEY`, `ADMIN_ROLE_KEY`)
- ESLint configuration updated to include all global Node.js packages
- Google service moved to `src/modules/google/` and users service moved to `src/modules/users/`

## [0.2.0] - 2026-05-02

### Added

- Express app setup with `src/app.js` and `src/server.js` (singleton pattern, graceful shutdown on SIGINT/SIGTERM)
- Modular project structure under `src/modules/` with scaffolded stubs for admin, ai, auth, google, and reports modules
- Prisma ORM with PostgreSQL: schema defining `User`, `DailyActivity`, and `Report` models with enums `Role` and `ReportStatus`
- Initial database migration (`20260430214657_init`) and seed script with sample employee data
- Shared middleware: `requestLogger` (HTTP access logging, skips `/health`) and `errorHandler` (4xx → warn, 5xx → error, hides internal details from clients)
- CRLF log-injection sanitization utility (`src/shared/utils/sanitize.js`) applied across all middleware logging
- Winston logger with colorized console transport and rotating JSON file transports for `error.log` and `combined.log`
- Jest test suite covering `errorHandler`, `requestLogger`, and `sanitizeForLog`
- Dockerfile using `node:20-slim` with non-root `node` user
- Docker Compose with `app` and `postgres:15` services
- CodeQL workflow for JavaScript/TypeScript security analysis on push and pull requests to `main`/`develop`
- PR description template (`.github/pull_request_template.md`)
- ESLint and Prettier configuration
- `.dockerignore` and `.env.example`

### Changed

- CI workflow updated to run from the repository root (removed `backend/` working-directory prefix)
- Security workflow refactored to install and run gitleaks binary locally instead of using the cloud-licensed action

## [0.1.1] - 2026-04-18

### Added

- Add develop branch

### Removed

- CI check till we have Node configured

### Changed

- Refactor security workflow so that github leaks uses binary local engine and not the cloud licence one.

## [0.1.0] - 2026-04-10

### Added

- Github initial configuration for github rules
