# Requerimientos Técnicos — Integración Jira

## 0. Metadata

| Campo                      | Valor                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| Módulo                     | `jira` (nuevo en `src/modules/jira/`)                                  |
| Feature / Épica            | F2B — Integración Jira API                                             |
| Autor(es)                  | Martín (PL · Backend SSR)                                              |
| Estado                     | Draft                                                                  |
| Fecha creación             | 2026-05-10                                                             |
| Última revisión            | 2026-05-10                                                             |
| Doc funcional asociado     | [docs/jira-integration/functional-requirements.md](./functional-requirements.md) (rev. 4) |
| Branch / PR                | `feature/F2B-jira-integration` — PRs chicos por subtarea                |
| Versión target             | `0.3.0`                                                                |

---

## 1. Resumen técnico

Se incorpora un módulo `jira` siguiendo el patrón de Monolito Modular del proyecto. La integración usa **OAuth 2.0 (3LO) de Atlassian** con refresh token rotation. El refresh token se persiste cifrado con `shared/utils/crypto.js` (AES‑256‑GCM, mismo modelo que Google).

El módulo expone una **operación de sync agnóstica del caller** con firma `syncForUser(userId, dateStart, dateEnd)`. No decide horarios ni consulta jornadas — solo procesa la ventana que recibe. Puede ser invocada por un orquestador, un cron, un endpoint HTTP de "sync ahora" o un script de recovery, sin cambios en el módulo.

El módulo asume el modelo de distribución **self‑hosted single‑tenant** del producto (ver FRD §1): no hay entidad `Company` en BD; cada empresa que despliega configura sus propias credenciales de la app OAuth en su `.env`.

- **Módulo afectado:** `src/modules/jira/` (nuevo) + extensiones puntuales en `prisma/schema.prisma` y `src/app.js` (montar rutas).
- **Nuevos archivos:**
  - `src/modules/jira/jira.routes.js`
  - `src/modules/jira/jira.controller.js`
  - `src/modules/jira/jira.service.js`
  - `src/modules/jira/jira.client.js` — adapter HTTP único contra Atlassian
  - `src/modules/jira/jira.mapper.js` — transformaciones puras Atlassian → `DailyActivity`
  - `src/modules/jira/jira.constants.js` — scopes, URLs base
  - `src/modules/jira/jira.errors.js` — errores tipados
  - `tests/modules/jira/jira.service.test.js`
  - `tests/modules/jira/jira.client.test.js`
  - `tests/modules/jira/jira.mapper.test.js`
  - `prisma/migrations/<timestamp>_add_jira_integration/migration.sql`
- **Decisiones clave:**
  - **OAuth 3LO** (no API Token) — contradice el C4 actual; se actualiza en follow‑up (§17).
  - **`fetch` nativo de Node 20** — no se agrega `axios`. El package no lo tiene hoy y no queremos sumar dependencia para 4 calls.
  - **Adapter `jira.client.js` aislado** — única capa con `fetch()`. El service llama métodos del client; los tests mockean el client.
  - **Idempotencia** vía columna `externalId` + unique compuesto `(userId, source, externalId)`, donde `externalId = "${issueKey}:${actionType}:${timestampIso}"`.
  - **`disconnect()` idempotente y reutilizable** — invocable desde el endpoint self‑service y desde la feature de eliminación de usuarios (RN-14 del FRD).
  - **Validación de existencia del user en BD** en cada endpoint Jira — defensa contra sesiones vivas tras eliminación por admin.
  - **Sin entidad `Company`** ni filtros cross‑tenant — el aislamiento es por deployment.

---

## 2. Arquitectura y ubicación en el código

### 2.1. Convención de capas

```
routes      → declara endpoints + middlewares (auth, validate)
controller  → adapta req/res ↔ service. Sin lógica de negocio.
service     → orquesta. Llama a client + mapper + Prisma. NO hace HTTP directo.
client      → adapter HTTP contra Atlassian. Único lugar con fetch().
mapper      → transformaciones puras Atlassian → modelo interno.
```

> Patrón base: `src/modules/google/google.service.js` y `src/modules/users/users.service.js`. La novedad respecto a `google` es la separación `service ↔ client` (en `google.service.js` están fusionadas porque usa `google-auth-library`); para Jira queremos `client` aparte porque facilita los tests y hace explícito el límite de la integración externa.

### 2.2. Diagrama de flujo

```
Frontend ──► /api/jira/auth          ──► controller ──► service ──► [validar user existe → generar state → persistir → devolver URL]
Frontend ──► /api/jira/auth/callback ──► controller ──► service ──► client.exchangeCode → client.getAccessibleResources
                                                                       │
                                                                       └─► prisma.user.update (refresh cifrado, cloudId, siteUrl)

Frontend ──► /api/jira/status        ──► controller ──► service ──► [validar user existe → leer flags + lastSync]
Frontend ──► DELETE /api/jira/connection ──► controller ──► service.disconnect(userId)
Frontend ──► POST /api/jira/sync     ──► controller ──► service.syncForUser(userId, dateStart, dateEnd)

(externo — orquestador / cron / script)
              ──► service.syncForUser(userId, dateStart, dateEnd)
                              │
                              ├─► prisma.user.findUnique
                              ├─► client.refreshAccessToken (rota refresh_token)
                              ├─► client.searchIssuesUpdatedInRange(cloudId, accessToken, dateStart, dateEnd)
                              ├─► client.getChangelog / .getComments / .getWorklogs por issue (concurrencia limitada)
                              ├─► mapper.toActivities(payload, ventana) → DailyActivity[]
                              └─► prisma.dailyActivity.createMany({ skipDuplicates: true })

(feature de gestión de usuarios — al eliminar un user)
              ──► service.disconnect(userId)   ← reutiliza la misma función que el endpoint self‑service
```

### 2.3. Dependencias hacia otros módulos del repo

| Depende de                                     | Por qué                                                        |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `shared/database/prisma.js`                    | Persistencia de `User` y `DailyActivity`                       |
| `shared/utils/crypto.js`                       | Cifrar/descifrar refresh tokens (AES‑256‑GCM)                  |
| `shared/utils/logger.js`                       | Logging estructurado (winston)                                 |
| `shared/middleware/errorHandler`               | Mapeo de errores tipados a status code                         |
| (futuro) `modules/auth/middleware`             | Proteger endpoints `/api/jira/*` — depende de F1-05            |

> **No depende de** `modules/google` ni de `modules/reports`. La consolidación con la timeline (F2-05) ocurre fuera de este módulo: el merge consume `DailyActivity[]` por `userId+date`, filtrando por `source`.

---

## 3. Contrato de API

> Prefijo común: `/api/jira`. Todos los endpoints **menos el callback** requieren middleware de auth interno (verificar JWT/sesión del usuario propio) — pendiente de F1-05.
>
> Todos los endpoints autenticados validan que el `userId` de la sesión corresponda a un `User` existente en BD. Si no existe → **404 `user_not_found`** (RN-09 del FRD).

### 3.1. `GET /api/jira/auth`

Inicia el flujo OAuth 3LO. Genera `state`, lo persiste asociado al usuario y devuelve la URL de autorización para que el frontend redirija.

- **Auth:** sesión del usuario.
- **Body / params:** ninguno.
- **Respuesta 200:**

```json
{
  "authorizationUrl": "https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=...&scope=read%3Ajira-work%20read%3Ajira-user%20read%3Ame%20offline_access&redirect_uri=...&state=...&response_type=code&prompt=consent"
}
```

> **Decisión:** devolver JSON (no 302) para que el frontend controle el `window.location.assign` y maneje su propio loading. Más fácil de testear y desacopla del fetch behavior del browser.

- **Errores:**

| Status | Caso                                                     |
| ------ | -------------------------------------------------------- |
| 401    | Sin sesión válida                                        |
| 404    | `user_not_found` — sesión viva pero user eliminado por admin |
| 500    | Falla al persistir el `state`                            |

---

### 3.2. `GET /api/jira/auth/callback`

Recibe el callback de Atlassian. Valida `state`, intercambia `code` por tokens, descubre `cloudId` y persiste credenciales cifradas.

- **Auth:** este endpoint **no** usa el middleware de sesión (Atlassian no envía nuestros headers). La autorización se infiere del `state`, que fue emitido para un user específico. Si el `state` no existe, expiró o el user asociado ya no está en BD → error.
- **Query params:** `code` (string), `state` (string). En caso de error: `error` (string), `error_description` (string).
- **Respuesta 302:** redirect al frontend con resultado:
  - éxito → `${FRONTEND_BASE_URL}/profile?jira=connected`
  - error → `${FRONTEND_BASE_URL}/profile?jira=error&reason=<code>`
  - cancelación → `${FRONTEND_BASE_URL}/profile?jira=cancelled`
- **Casos manejados internamente:**

| Caso                                          | Comportamiento                                        | Log    |
| --------------------------------------------- | ----------------------------------------------------- | ------ |
| `error=access_denied` (user canceló)          | `redirect ?jira=cancelled`                            | `info` |
| `state` inválido / expirado / desconocido     | `redirect ?jira=error&reason=invalid_state`           | `warn` |
| `state` válido pero user ya no existe         | `redirect ?jira=error&reason=user_not_found`          | `warn` |
| Intercambio de code falla (4xx/5xx Atlassian) | `redirect ?jira=error&reason=token_exchange_failed`   | `error` |
| `accessibleResources` viene vacío             | `redirect ?jira=error&reason=no_jira_site`            | `warn` |
| Persistencia DB falla                         | `redirect ?jira=error&reason=persistence_failed`      | `error` |

---

### 3.3. `GET /api/jira/status`

Devuelve el estado de la conexión Jira del usuario actual.

- **Auth:** sesión del usuario.
- **Respuesta 200:**

```json
{
  "connected": true,
  "siteUrl": "acme.atlassian.net",
  "lastSyncAt": "2026-05-09T22:00:00.000Z",
  "reconnectRequired": false
}
```

> Si `connected = false`, los demás campos son `null`.

- **Errores:**

| Status | Caso                |
| ------ | ------------------- |
| 401    | Sin sesión          |
| 404    | `user_not_found`    |

---

### 3.4. `DELETE /api/jira/connection`

Desconecta la cuenta de Jira del usuario actual. **Idempotente** — si el user no estaba conectado, igualmente devuelve `204`.

- **Auth:** sesión del usuario.
- **Comportamiento:**
  1. Best effort: `POST` a `https://auth.atlassian.com/oauth/token/revoke` con el refresh token (errores ignorados).
  2. `prisma.user.update`: setea `jiraRefreshToken=null, jiraCloudId=null, jiraSiteUrl=null, jiraConnectedAt=null, jiraReconnectRequired=false`.
  3. Las `DailyActivity` con `source='jira'` previas **se conservan** (RN-14 del FRD).
- **Respuesta 204** sin body.
- **Errores:**

| Status | Caso                |
| ------ | ------------------- |
| 401    | Sin sesión          |
| 404    | `user_not_found`    |

> La función `service.disconnect(userId)` que implementa esto es **reutilizable** desde la feature de eliminación de usuarios (RN-14 del FRD: "al eliminar un user, invocar disconnect"). Su contrato es idempotente para que el caller del CRUD no necesite verificar conexión previa.

---

### 3.5. `POST /api/jira/sync`

Dispara una sincronización para el usuario autenticado en una ventana de tiempo dada. Envuelve el método `service.syncForUser`.

- **Auth:** sesión del usuario.
- **Body:**

```json
{
  "dateStart": "2026-05-10T09:00:00.000Z",
  "dateEnd": "2026-05-10T18:00:00.000Z"
}
```

- **Validación:** ambos campos son ISO 8601 con timezone; `dateStart < dateEnd`; ventana ≤ 24 hs.
- **Respuesta 200:**

```json
{
  "imported": 7,
  "skippedDuplicates": 2,
  "durationMs": 1843
}
```

- **Errores:**

| Status | Caso                                                              |
| ------ | ----------------------------------------------------------------- |
| 400    | Ventana inválida (`dateStart >= dateEnd`, falta uno, > 24 hs, formato no ISO) |
| 401    | Sin sesión                                                        |
| 404    | `user_not_found`                                                  |
| 409    | `not_connected` — user no tiene conexión Jira                     |
| 409    | `reconnect_required` — flag activo, debe reconectar antes         |
| 502    | `upstream_error` — falla en Atlassian tras retries                |
| 504    | `upstream_timeout` — timeout tras retries                         |

> Este endpoint es la versión HTTP del método interno. Un orquestador / cron externo puede llamar directamente a `service.syncForUser(userId, dateStart, dateEnd)` sin pasar por HTTP.

---

## 4. Modelo de datos

### 4.1. Cambios en `prisma/schema.prisma`

```prisma
model User {
  id                       String    @id @default(uuid())
  email                    String    @unique
  fullName                 String?   @map("full_name")
  role                     Role      @default(EMPLOYEE)
  googleId                 String?   @unique @map("google_id")
  refreshToken             String?   @map("refresh_token")
  // —— Jira (nuevo) ——
  jiraRefreshToken         String?   @map("jira_refresh_token")        // cifrado AES-256-GCM
  jiraCloudId              String?   @map("jira_cloud_id")
  jiraSiteUrl              String?   @map("jira_site_url")
  jiraConnectedAt          DateTime? @map("jira_connected_at")
  jiraLastSyncAt           DateTime? @map("jira_last_sync_at")
  jiraReconnectRequired    Boolean   @default(false) @map("jira_reconnect_required")
  // ————————————————
  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @default(now()) @updatedAt @map("updated_at")

  activities               DailyActivity[]
  reports                  Report[]
  jiraOAuthStates          JiraOAuthState[]

  @@map("users")
}

// Estado del OAuth 3LO durante el flujo (válido por minutos, se borra al consumir)
model JiraOAuthState {
  state       String   @id                 // 32 bytes hex
  userId      String   @map("user_id")
  expiresAt   DateTime @map("expires_at")  // now() + 10 min
  createdAt   DateTime @default(now()) @map("created_at")

  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("jira_oauth_states")
}

model DailyActivity {
  id           String   @id @default(uuid())
  userId       String   @map("user_id")
  source       String                                                  // 'calendar' | 'drive' | 'jira'
  activityType String   @map("activity_type")
  externalId   String?  @map("external_id")                              // NUEVO — clave externa idempotente
  startTime    DateTime @map("start_time")
  endTime      DateTime @map("end_time")
  metadata     Json?
  createdAt    DateTime @default(now()) @map("created_at")

  user         User     @relation(fields: [userId], references: [id])

  @@index([userId, startTime])
  @@index([userId, source, startTime])                                  // NUEVO — filtros por fuente
  @@unique([userId, source, externalId])                                // NUEVO — idempotencia
  @@map("daily_activities")
}
```

#### Notas

- **`externalId` es nullable** porque no todas las fuentes lo van a tener. Los inserts de Jira **siempre** lo setean (`"${issueKey}:${actionType}:${timestampIso}"`).
- En Postgres, los `NULL` no chocan en `unique` — múltiples activities sin `externalId` por user/source son válidas.
- **Se descarta** convertir `source` a enum en este PR para no acoplar F2B con F2; queda como follow‑up (§17).
- **No se agrega entidad `Company`** — el modelo es single‑tenant por deployment (FRD §1).
- **No hay `JiraConnection` separada** — los campos Jira viven en `User`. Justificación: relación 1:0..1, sin necesidad de versionar múltiples conexiones por user. Si en el futuro hace falta multi‑site, se extrae a tabla aparte.

### 4.2. Migración

- **Nombre:** `npx prisma migrate dev --name add_jira_integration` → `prisma/migrations/<timestamp>_add_jira_integration/migration.sql`.
- **Backfill:** ninguno (los nuevos campos son opcionales o tienen default `false`).
- **Reversibilidad:** sí — drop de columnas y de la tabla `jira_oauth_states`.
- **Impacto en `prisma/seed.js`:** opcional — agregar 1 user seed con `jiraConnectedAt` para facilitar pruebas locales.

### 4.3. Convenciones (heredadas del schema actual)

- IDs UUID, naming camelCase con `@map` a snake_case.
- Timestamps `createdAt` / `updatedAt`.
- Índices sobre los pares de filtrado más comunes.

---

## 5. Integraciones externas

### 5.1. Atlassian — OAuth 3LO + Jira REST API v3

> **Modelo de distribución:** la plataforma es self‑hosted single‑tenant. Cada empresa que despliega registra su **propia app OAuth en developer.atlassian.com** apuntando a la URL de su deployment, y configura sus propias `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` / `JIRA_REDIRECT_URI` en su `.env`. **No hay credenciales compartidas entre customers.**

- **Doc oficial:** disponible en `developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps` y `developer.atlassian.com/cloud/jira/platform/rest/v3`.
- **Cliente HTTP:** `fetch` nativo de Node 20. Se construye un mini cliente en `jira.client.js` con métodos tipados por endpoint.
- **Endpoints consumidos:**

| Endpoint                                                                           | Método | Para qué |
| ---------------------------------------------------------------------------------- | ------ | -------- |
| `https://auth.atlassian.com/authorize`                                             | (URL)  | URL de autorización — se construye y devuelve, no se llama |
| `https://auth.atlassian.com/oauth/token`                                           | POST   | Intercambio `code → tokens`, y refresh |
| `https://auth.atlassian.com/oauth/token/revoke`                                    | POST   | Revocar refresh al desconectar (best effort) |
| `https://api.atlassian.com/oauth/token/accessible-resources`                       | GET    | Obtener `cloudId` + `siteUrl` |
| `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/myself`                    | GET    | (opcional) validar conexión, obtener email |
| `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/search`                    | GET    | JQL: `assignee = currentUser() AND updated >= "{dateStart}" AND updated < "{dateEnd}"` con paginación |
| `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{key}/changelog`     | GET    | Transitions del rango |
| `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{key}/comment`       | GET    | Comments — filtrar en código por `author = me` y por `created` dentro de la ventana |
| `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{key}/worklog`       | GET    | Worklogs — filtrar por `author = me` y por `started` dentro de la ventana |

- **Autenticación:** OAuth 2.0 (3LO).
  - Scopes: `read:jira-work`, `read:jira-user`, `read:me`, `offline_access` (necesario para refresh).
  - **Refresh token rotation está habilitado** por Atlassian: cada refresh devuelve un **nuevo** refresh token. El client persiste el nuevo refresh **antes** de devolver el access token al caller; si la persistencia falla, propaga el error y NO usa el access token (el viejo refresh sigue siendo válido por una ventana, según docs).
- **Almacenamiento de credenciales:** `User.jiraRefreshToken` cifrado con `crypto.encrypt()`. **Nunca** se persiste el access token (TTL ~1h, se obtiene fresh en cada sync).
- **Filtro por ventana:** JQL filtra por `updated` con precisión de minuto. Para ventanas que no caen en bordes de minuto, el mapper hace post‑filter en código (descarta acciones con timestamp fuera de `[dateStart, dateEnd)`).

#### Manejo de errores upstream

| Caso                                          | Acción |
| --------------------------------------------- | ------ |
| Timeout (default `JIRA_REQUEST_TIMEOUT_MS=10000`) | Retry 1× con backoff 1s; si falla → `JiraTimeoutError` (504) |
| 401 en refresh (`invalid_grant`)              | Marcar `reconnectRequired = true`, log `warn`, lanzar `JiraReconnectRequiredError`. El sync para este user se aborta limpio. |
| 401 en endpoint API (token expiró mid‑sync)   | Refrescar 1× y reintentar; si vuelve a fallar → `reconnectRequired` |
| 403 (scopes insuficientes / revocados)        | `reconnectRequired`, log `error` |
| 429 rate limit                                | Respetar `Retry-After`; si no viene, backoff 2s y 1 retry |
| 5xx                                           | Retry 2× con backoff exponencial (1s, 2s); si falla → `JiraUpstreamError` (502) |

- **Rate limits conocidos:** Jira Cloud no publica límites duros pero recomienda < 10 req/s sostenidos. El sync por usuario hace típicamente 1 + N × 3 calls (1 search + 3 por issue). Para N > 30, considerar concurrencia limitada (3 a la vez) en una segunda iteración.

#### Estrategia "sin doc oficial del cliente"

> Las preguntas funcionales abiertas se cerraron en rev. 4 del FRD: no se filtra por projectKey, no se necesitan custom fields, no se distingue interno/cliente. **No queda dependencia bloqueante de Finegans para arrancar.** El mapper queda limpio sin configuración tenant‑específica.

---

## 6. Configuración y variables de entorno

| Variable                    | Requerida | Tipo / Formato                  | Descripción                                                              | Default |
| --------------------------- | --------- | ------------------------------- | ------------------------------------------------------------------------ | ------- |
| `JIRA_CLIENT_ID`            | sí        | string                          | Client ID de la app OAuth registrada por la empresa que despliega        | —       |
| `JIRA_CLIENT_SECRET`        | sí        | string (secreta)                | Client secret de la app OAuth                                            | —       |
| `JIRA_REDIRECT_URI`         | sí        | URL absoluta                    | URL del callback. Debe coincidir EXACTAMENTE con la registrada en la app | —       |
| `JIRA_SCOPES`               | no        | string (space‑separated)        | Scopes a solicitar                                                       | `read:jira-work read:jira-user read:me offline_access` |
| `JIRA_REQUEST_TIMEOUT_MS`   | no        | número                          | Timeout por request a Atlassian                                          | `10000` |
| `JIRA_SYNC_MAX_WINDOW_HOURS` | no       | número                          | Ventana máxima aceptada por `POST /api/jira/sync`                         | `24`    |
| `FRONTEND_BASE_URL`         | sí        | URL absoluta                    | Base del frontend para construir el redirect post‑callback               | —       |

**Validación al boot:** seguir el patrón de `google.service.js`:

```js
if (!process.env.JIRA_CLIENT_ID) {
  throw new Error('JIRA_CLIENT_ID environment variable is required');
}
```

> No leer envs dentro de funciones por‑request. Cargar al import del módulo, fallar rápido si falta algo crítico.
> Documentar las nuevas vars en `.env.example` (W2 ya estableció la convención de "agregar líneas al final").

---

## 7. Seguridad

- [x] **Autenticación:** los endpoints `/api/jira/*` excepto `callback` requieren middleware de auth interno (depende de F1-05). El callback valida `state` estrictamente.
- [x] **Validación de existencia del user:** todos los endpoints autenticados verifican que el `userId` de la sesión exista en BD antes de operar (defensa contra eliminación por admin con sesión viva).
- [x] **Autorización:** todos los endpoints operan **solo sobre el usuario autenticado** — un user no puede ver/modificar la conexión Jira de otro. Sin rol especial — es feature self‑service.
- [x] **CSRF / state:** `crypto.randomBytes(32).toString('hex')`, persistido en `JiraOAuthState` con TTL de 10 minutos, one‑shot (se borra al consumir). State desconocido o expirado → `redirect ?jira=error&reason=invalid_state`.
- [x] **Sanitización de input:** `code`, `state`, `error` del callback se validan como strings de longitud razonable. `dateStart` / `dateEnd` se validan como ISO 8601 antes de cualquier uso.
- [x] **Cifrado en reposo:** `User.jiraRefreshToken` cifrado con AES‑256‑GCM. `ENCRYPTION_KEY` debe estar seteada en todos los entornos.
- [x] **Tokens nunca al frontend:** ni access ni refresh salen del backend. El frontend solo ve `connected: bool` + metadata pública.
- [x] **Tokens nunca en logs:** el `requestLogger` no debe loguear bodies/queries que contengan `code`, `access_token` o `refresh_token`. Verificar antes de mergear.
- [x] **CORS:** sin cambios en este PR. El TODO de restringir orígenes en `app.js` aplica antes de prod.
- [x] **OWASP Top 10 relevantes:**
  - **A01 Broken Access Control:** mitigado por "user solo opera sobre sí mismo" + validación de existencia.
  - **A02 Cryptographic Failures:** AES‑256‑GCM ya validado en el repo (`tests/shared/utils/crypto.test.js`).
  - **A07 Identification & Auth Failures:** `state` no predecible + TTL.
  - **A10 SSRF:** URLs base son constantes en `jira.constants.js`. El `cloudId` viene de Atlassian (no del user) y se valida formato `[a-zA-Z0-9-]+` antes de interpolarlo.

---

## 8. Logging y observabilidad

- Logger: `shared/utils/logger.js` (winston). Nunca `console.log`.
- **Eventos `info`:**
  - `jira.connection.initiated` (`{ userId }`)
  - `jira.connection.completed` (`{ userId, cloudId, siteUrl }` — sin tokens)
  - `jira.connection.disconnected` (`{ userId, source: 'self' | 'admin_delete' }`)
  - `jira.sync.completed` (`{ userId, dateStart, dateEnd, imported, skippedDuplicates, durationMs }`)
- **Eventos `warn`:**
  - `jira.callback.invalid_state` (`{ state }`)
  - `jira.callback.user_not_found` (`{ userId }`)
  - `jira.callback.user_cancelled` (`{ userId }`)
  - `jira.refresh.invalid_grant` (`{ userId }`) → marca reconnect
  - `jira.upstream.timeout` (`{ endpoint, attempt }`)
- **Eventos `error`:**
  - `jira.token_exchange.failed` (`{ userId, status }` — sin response body)
  - `jira.upstream.5xx` (`{ endpoint, status, attempt }`)
  - `jira.persistence.failed` (`{ userId, operation, error }`)
- **Nunca loguear:** `code`, `access_token`, `refresh_token`, `client_secret`, payloads completos de Atlassian.

---

## 9. Manejo de errores

Errores tipados nuevos en `src/modules/jira/jira.errors.js`:

```js
class JiraError extends Error {}                            // base
class JiraUserNotFoundError extends JiraError {}            // → 404
class JiraInvalidStateError extends JiraError {}            // → 400 (interno; el callback redirecciona)
class JiraNotConnectedError extends JiraError {}            // → 409 not_connected
class JiraReconnectRequiredError extends JiraError {}       // → 409 reconnect_required (también marca flag)
class JiraInvalidWindowError extends JiraError {}           // → 400
class JiraTimeoutError extends JiraError {}                 // → 504
class JiraUpstreamError extends JiraError {}                // → 502
```

- `errorHandler` global mapea cada subclase a su status code.
- Mensajes en español (consistente con el código existente).
- Encadenar causa con `new JiraUpstreamError('msg', { cause: error })`.
- Desde controllers: nunca `res.status(500).send(...)` a mano; siempre `next(error)`.

---

## 10. Testing

> **Política del repo:** `coverageThreshold` exige **≥ 80%** en `lines`, `branches`, `functions`, `statements`. El CI bloquea si baja.

### 10.1. Ubicación

```
tests/modules/jira/jira.service.test.js
tests/modules/jira/jira.client.test.js
tests/modules/jira/jira.mapper.test.js
tests/modules/jira/jira.controller.test.js   ← solo si la lógica de adaptación es no‑trivial
```

### 10.2. Convenciones (heredadas de `users.service.test.js`)

- `jest.mock('../../../src/shared/database/prisma', () => ({ user: { … }, jiraOAuthState: { … }, dailyActivity: { … } }))`.
- `jest.mock('../../../src/modules/jira/jira.client')` para los tests del service.
- `beforeEach(() => jest.clearAllMocks())`.
- Aserciones explícitas sobre **argumentos** (`toHaveBeenCalledWith`), no solo sobre returns.

### 10.3. Casos mínimos a cubrir

#### `jira.service.test.js`

- [ ] `initiateConnection(userId)` happy path — valida user, genera state, persiste con TTL, devuelve URL con scopes correctos.
- [ ] `initiateConnection` con user inexistente → `JiraUserNotFoundError`.
- [ ] `handleCallback(code, state)` happy path — intercambia, descubre cloudId, persiste cifrado, borra state.
- [ ] `handleCallback` con state inválido → `JiraInvalidStateError`.
- [ ] `handleCallback` con state válido pero user borrado → maneja como `user_not_found`.
- [ ] `handleCallback` cuando `accessibleResources` viene vacío.
- [ ] `getStatus(userId)` para user conectado, desconectado, y con `reconnectRequired`.
- [ ] `getStatus` con user inexistente → `JiraUserNotFoundError`.
- [ ] `disconnect(userId)` happy path con conexión existente (revoke OK).
- [ ] `disconnect(userId)` happy path con revoke falla (best effort, no bloquea).
- [ ] `disconnect(userId)` cuando user no está conectado → no‑op idempotente, no lanza.
- [ ] `disconnect(userId)` con user inexistente → no‑op idempotente, no lanza (para que la feature de admin delete pueda llamarlo sin chequeo previo).
- [ ] `syncForUser(userId, dateStart, dateEnd)` happy path — refresca token, busca issues, importa N actividades.
- [ ] `syncForUser` con `dateStart >= dateEnd` → `JiraInvalidWindowError`.
- [ ] `syncForUser` cuando user no está conectado → `JiraNotConnectedError`.
- [ ] `syncForUser` cuando refresh devuelve `invalid_grant` → marca `reconnectRequired`, lanza `JiraReconnectRequiredError`.
- [ ] `syncForUser` con ventana sin actividad → no inserta nada, marca `lastSyncAt`, devuelve `{imported: 0}`.
- [ ] `syncForUser` idempotente — segundo run con misma ventana no inserta duplicados (verificar `skipDuplicates: true`).
- [ ] `syncForUser` filtra acciones fuera de la ventana — issue updated dentro pero comment fuera no se importa.

#### `jira.client.test.js`

- [ ] `exchangeCodeForTokens` happy path (mockear `global.fetch`).
- [ ] `exchangeCodeForTokens` 4xx → `JiraUpstreamError`.
- [ ] `refreshAccessToken` happy path — devuelve nuevo access + nuevo refresh.
- [ ] `refreshAccessToken` `invalid_grant` → error específico.
- [ ] `getAccessibleResources` happy path.
- [ ] `searchIssuesUpdatedInRange` con paginación (recorre `nextPageToken` o `startAt`).
- [ ] Construcción correcta de URL con `cloudId`, query params encoded.
- [ ] Timeout configurable (mock con `setTimeout` largo + `AbortController`).
- [ ] 429 con `Retry-After` (verificar que se respeta).
- [ ] 5xx con retry exponencial (verificar 3 attempts).

#### `jira.mapper.test.js`

- [ ] `mapChangelogToActivities` — happy path con 2 transitions dentro de la ventana.
- [ ] `mapChangelogToActivities` — descarta entries con timestamp fuera de la ventana.
- [ ] `mapCommentsToActivities` — filtra por `author = userEmail` y por `created` dentro de la ventana.
- [ ] `mapWorklogsToActivities` — usa `started` + `timeSpentSeconds` para start/end.
- [ ] `externalId` se construye de forma determinista (mismo input → mismo `externalId`).

### 10.4. Mapeo HU ↔ test (a completar al cerrar el PR)

| Escenario funcional                                      | Archivo de test               | Nombre del test |
| -------------------------------------------------------- | ----------------------------- | --------------- |
| HU‑01 happy path (autoriza primera vez)                   | `jira.service.test.js`        | "initiateConnection genera state y URL correcta" |
| HU‑01 sesión válida pero user borrado                    | `jira.service.test.js`        | "initiateConnection lanza JiraUserNotFoundError si el user no existe" |
| HU‑01 callback con state inválido                        | `jira.service.test.js`        | "handleCallback rechaza state desconocido" |
| HU‑01 user cancela en Atlassian                          | `jira.controller.test.js`     | "callback redirige a /profile?jira=cancelled cuando error=access_denied" |
| HU‑02 sync con actividad en ventana                      | `jira.service.test.js`        | "syncForUser importa N actividades dentro de la ventana" |
| HU‑02 ventana sin actividad                              | `jira.service.test.js`        | "syncForUser con ventana vacía devuelve imported=0" |
| HU‑02 acciones fuera de la ventana                       | `jira.mapper.test.js`         | "mapper descarta entries fuera de [dateStart, dateEnd)" |
| HU‑02 idempotencia                                        | `jira.service.test.js`        | "syncForUser segundo run no duplica" |
| HU‑02 ventana inválida                                   | `jira.service.test.js`        | "syncForUser con dateStart>=dateEnd lanza JiraInvalidWindowError" |
| HU‑03 status                                              | `jira.service.test.js`        | "getStatus devuelve { connected, lastSyncAt, reconnectRequired }" |
| HU‑03 desconexión self‑service                           | `jira.service.test.js`        | "disconnect borra credenciales y conserva activities" |
| HU‑03 disconnect idempotente para admin delete           | `jira.service.test.js`        | "disconnect no lanza si user no estaba conectado" |
| HU‑03 refresh falla → reconnect                          | `jira.service.test.js`        | "syncForUser marca reconnectRequired ante invalid_grant" |
| RN‑14 admin delete invoca disconnect                     | (cubierto en feature user CRUD) | n/a — gancho de integración |

### 10.5. Coverage local

```bash
npm run test:coverage
```

> Archivos excluidos por `package.json` (`*.constants.js`, `*.config.js`, `**/index.js`): `jira.constants.js` no cuenta para coverage. Asegurarse que la lógica esté en `service`, `client`, `mapper` (sí cuentan).

---

## 11. Performance y límites

- **Sync por usuario:** O(1 + N) requests a Atlassian, donde N = issues actualizados en la ventana. Para N > 30 considerar concurrencia 3 con `Promise.allSettled`.
- **Caller (orquestador / cron):** debe limitar concurrencia entre usuarios (sugerido: 5 paralelos) para no saturar el rate limit global de Atlassian.
- **Queries Prisma:** `dailyActivity.createMany` con array completo, no `create` por item.
- **Timeouts:** explícitos vía `AbortController` en `fetch`. Default 10s, configurable por env.
- **Paginación:** `/search` con `startAt` + `maxResults=50`. Loop hasta `total <= startAt + maxResults`.
- **Ventana máxima:** validar `dateEnd - dateStart <= JIRA_SYNC_MAX_WINDOW_HOURS` (default 24h) — protege contra invocaciones que pidan rangos enormes y disparen rate limits.

---

## 12. Despliegue y operaciones

- **Migración Prisma:** `npx prisma migrate deploy` antes de arrancar el proceso.
- **Compatibilidad hacia atrás:** la feature es aditiva — usuarios sin Jira conectado siguen funcionando. No requiere flag.
- **Rollback:** revertir la migración Prisma (drop de columnas + `jira_oauth_states`). `DailyActivity` previas con `source='jira'` quedan con la columna `external_id` poblada (no rompe nada en otras fuentes).
- **Healthcheck:** `/health` no se modifica.
- **Setup en cada deployment** (responsabilidad de la empresa que despliega):
  1. Registrar app OAuth en `developer.atlassian.com`.
  2. Configurar `JIRA_REDIRECT_URI` apuntando a la URL pública de la instancia.
  3. Setear `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`, `FRONTEND_BASE_URL`, `ENCRYPTION_KEY` en su `.env` / secret manager.
  4. Documentar en el README de deploy (futuro).

---

## 13. CI / Pipeline

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:coverage` ≥ 80% global
- [ ] `pr-guard.yml`, `security.yml`, `codeql.yml` sin findings nuevos
- [ ] Sin secretos detectados por gitleaks (recordar `.gitleaksignore` para keys de test conocidas)

---

## 14. Riesgos técnicos y mitigaciones

| Riesgo                                                                                        | Probabilidad | Impacto | Mitigación |
| --------------------------------------------------------------------------------------------- | ------------ | ------- | ---------- |
| Refresh token rotation: si la persistencia falla, queda token huérfano                         | baja         | alto    | Persistir nuevo refresh **antes** de devolver el access; si falla, propagar y NO usar el access (el viejo refresh sigue válido por una ventana) |
| Rate limit de Atlassian al sincronizar muchos users en paralelo                                | media        | medio   | Caller limita concurrencia entre users (5 paralelos). Backoff con `Retry-After` |
| Atlassian deprecó `/rest/api/2` — usamos v3, pero algunos campos cambian                       | baja         | medio   | Tests del mapper cubren shape esperada. Si Atlassian cambia, tests fallan ANTES de prod |
| Cliente que despliega usa Jira Server / DC en vez de Cloud (SU-04 del FRD)                     | baja         | alto    | Validar en el onboarding de cada nuevo customer. Si confirman Server, este plan no aplica |
| User borrado por admin con sesión viva sigue mandando requests                                 | media        | bajo    | Validación de existencia en cada endpoint (§7). Devuelve 404 limpio. |
| Un user con miles de issues actualizados en la ventana satura el sync                           | baja         | medio   | `JIRA_SYNC_MAX_WINDOW_HOURS` + concurrencia limitada |
| Ventana mal calculada por el caller (ej: cron pasa `dateEnd` futuro)                          | media        | bajo    | Sync acepta ventanas futuras (no rompe), JQL devuelve vacío. Logs registran la ventana. |
| `disconnect()` se llama desde admin delete pero el endpoint Atlassian de revoke está caído     | media        | bajo    | Revoke es best effort — credenciales locales se limpian igual. Eventualmente las creds en Atlassian quedan huérfanas pero sin impacto operacional |
| `state` en `JiraOAuthState` se acumula en BD por callbacks que nunca llegan                   | alta         | bajo    | TTL + job de limpieza opcional (post‑MVP). Mientras tanto, fila por fila ocupa < 200 bytes — irrelevante en escala MVP |

---

## 15. Tareas de implementación (mapeadas al Gantt F2B)

> Orden sugerido para PRs chicos (< 48h cada uno).

- [ ] **F2B-01.x** — Registrar app OAuth en `developer.atlassian.com` (no es código). Validar scopes en API browser. Documentar credenciales como placeholders en `.env.example`.
- [ ] **F2B-02.x** — Spike: probar el flujo OAuth end‑to‑end contra cuenta personal (script standalone, no se mergea). Documentar findings en `docs/jira-integration/findings.md`.
- [ ] **PR 1** (F2B-03.x) — Migración Prisma: extensiones a `User`, tabla `JiraOAuthState`, columna `externalId` + unique en `DailyActivity`. Smoke test del client generado.
- [ ] **PR 2** — `jira.constants.js` + `jira.errors.js` + `jira.client.js` con `exchangeCodeForTokens`, `refreshAccessToken`, `getAccessibleResources`, `revokeRefreshToken`. Tests del client con `fetch` mockeado.
- [ ] **PR 3** (F2B-04.1/2) — `jira.service.js` con `initiateConnection`, `handleCallback`, `getStatus`, `disconnect`. Tests del service (mock client + mock prisma).
- [ ] **PR 4** — `jira.mapper.js` (mapeos puros) + tests del mapper.
- [ ] **PR 5** (F2B-04.3/4/5/6) — `syncForUser` en service + extensión del client con `searchIssuesUpdatedInRange`, `getChangelog`, `getComments`, `getWorklogs`. Tests de happy path + errores + idempotencia + filtrado por ventana.
- [ ] **PR 6** — `jira.controller.js` + `jira.routes.js` + wire‑up en `src/app.js`. Tests de controller (validación de body, mapeo error → status, redirect del callback).
- [ ] **F2B-05** — PR 7 (depende de F2-05): hook del consolidador de timeline para incluir `source='jira'`. Tests del consolidador extendidos.
- [ ] **Doc final:** completar §10.4 (mapping HU ↔ test) y actualizar §17 (follow‑ups).
- [ ] **CHANGELOG:** entrada para `0.3.0`.
- [ ] **PR template completado** en cada PR.

---

## 16. Open questions técnicas

- [ ] **#T1** — Si la feature de eliminación de usuarios todavía no existe cuando F2B esté listo, ¿alcanza con dejar `disconnect()` exportado y documentado, o agregamos un test de integración stub?
- [ ] **#T2** — ¿Hace falta una tabla de auditoría separada para conexiones/desconexiones, o alcanza con logs estructurados? (sospecha: alcanza con logs en MVP)
- [ ] **#T3** — Migrar `DailyActivity.source` de `String` a `enum` (TODO existente del schema): ¿lo metemos en este PR o en uno separado coordinado con el dueño de F2?
- [ ] **#T4** — Job de limpieza de `JiraOAuthState` expirados: cron interno, comando manual, o nada por ahora?

---

## 17. Follow-ups y deuda técnica conocida

- [ ] **Actualizar el C4** ([documentation/architecture/C4-architecture.md:109](../../../documentation/architecture/C4-architecture.md#L109)): reemplazar "Jira via API Token" por "Jira via OAuth 2.0 (3LO)" y referenciar este doc.
- [ ] **Crear ADR-006** "Jira OAuth 3LO vs API Token": documentar la decisión y consecuencias siguiendo el formato de `ADR-001-stack.md`.
- [ ] **Migrar `DailyActivity.source` a enum** una vez F2 (Google) y F2B (Jira) estén estables (TODO en `prisma/schema.prisma:53` y `:55`).
- [ ] **Webhooks Atlassian** (sync push) como mejora post‑MVP — eliminaría la latencia del cron diario.
- [ ] **Soporte multi‑site por user** — si algún customer lo requiere.
- [ ] **Job de limpieza de `JiraOAuthState`** expirados (ver #T4).
