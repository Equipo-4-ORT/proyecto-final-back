# Requerimientos Técnicos — `<Nombre del módulo / feature>`

> Template para documentar **cómo** se implementa la feature.
> Asume que existe un documento funcional aprobado (ver metadata).
> Este template está calibrado al stack y reglas actuales del repo:
> Node 20+, Express 5, Prisma + PostgreSQL, Jest (coverage ≥ 80%),
> Winston, ESLint, arquitectura modular `src/modules/<name>/`.

---

## 0. Metadata

| Campo                      | Valor                                              |
| -------------------------- | -------------------------------------------------- |
| Módulo                     | `<auth \| google \| jira \| reports \| …>`         |
| Feature / Épica            | `<nombre>`                                         |
| Autor(es)                  | `<nombre>`                                         |
| Estado                     | `Draft \| In Review \| Approved \| Implemented`    |
| Fecha creación             | `YYYY-MM-DD`                                       |
| Última revisión            | `YYYY-MM-DD`                                       |
| Doc funcional asociado     | `docs/<feature>/functional-requirements.md`       |
| Branch / PR                | `feature/<slug>` — PR `<#>`                        |
| Versión target             | `package.json#version`                             |

---

## 1. Resumen técnico

> 3‑5 oraciones. Qué se construye, dónde vive en el código, qué decisiones
> arquitectónicas no obvias se tomaron.

- **Módulo afectado:** `src/modules/<name>/`
- **Nuevos archivos esperados:**
  - `src/modules/<name>/<name>.routes.js`
  - `src/modules/<name>/<name>.controller.js`
  - `src/modules/<name>/<name>.service.js`
  - `tests/modules/<name>/<name>.service.test.js`
- **Decisión clave:** …

---

## 2. Arquitectura y ubicación en el código

### 2.1. Convención de capas (debe respetarse)

```
routes        → declara endpoints + middlewares (auth, validate, sanitize)
controller    → adapta req/res ↔ service. Sin lógica de negocio. Sin acceso a DB.
service       → lógica de negocio. Llama a Prisma, a clientes externos, a utils.
shared/       → infraestructura cross-module (config, db, logger, middleware, utils)
```

> Patrón existente de referencia: `src/modules/google/google.service.js` +
> `src/modules/users/users.service.js`. Replicar separación.

### 2.2. Diagrama de flujo

```
<cliente> ──► routes ──► controller ──► service ──► [prisma | http externo | crypto]
                                          │
                                          └─► logger (winston)
errorHandler (shared/middleware) ◄── errores propagados
```

### 2.3. Dependencias hacia otros módulos

| Depende de                  | Por qué                                   |
| --------------------------- | ----------------------------------------- |
| `shared/database/prisma.js` | Persistencia                              |
| `shared/utils/logger.js`    | Logs estructurados                        |
| `shared/utils/crypto.js`    | Cifrado de campos sensibles (AES‑256‑GCM) |
| `shared/middleware/…`       | requestLogger, errorHandler               |
| `modules/<otro>/…`          | …                                         |

---

## 3. Contrato de API

> Documentar todos los endpoints nuevos / modificados.

### 3.1. `<MÉTODO> /api/<recurso>`

- **Auth:** `<pública \| token \| ADMIN>`
- **Headers requeridos:** …
- **Path params:** …
- **Query params:** …
- **Body (request):**

```json
{
  "...": "..."
}
```

- **Respuesta 2xx:**

```json
{
  "...": "..."
}
```

- **Errores (vía `errorHandler`):**

| Status | Caso                       | Mensaje devuelto |
| ------ | -------------------------- | ---------------- |
| 400    | Validación de payload      | …                |
| 401    | Token inválido / faltante  | …                |
| 403    | Rol insuficiente           | …                |
| 404    | Recurso no existe          | …                |
| 409    | Conflicto (unique, estado) | …                |
| 502    | Falla de servicio externo  | …                |

> Todos los errores deben pasar por `shared/middleware/errorHandler.js` con
> `Error` o subclases tipadas (ver `InvalidCiphertextError` como ejemplo).

---

## 4. Modelo de datos

### 4.1. Cambios en `prisma/schema.prisma`

```prisma
// Pegar acá el delta exacto a aplicar.
```

### 4.2. Migración

- **Nombre:** `prisma migrate dev --name <slug>` → `prisma/migrations/<timestamp>_<slug>/`
- **Backfill / data migration necesaria:** `<sí / no>` — si sí, describir script.
- **Reversibilidad:** `<sí / no>` — si rompe compatibilidad, justificar.
- **Impacto en `prisma/seed.js`:** …

### 4.3. Convenciones (heredadas del schema actual)

- IDs: `String @id @default(uuid())`
- Naming: camelCase en Prisma, `@map` a snake_case en SQL (`@@map("…")`)
- Timestamps: `createdAt`, `updatedAt` con `@default(now())` y `@updatedAt`
- Para relaciones N‑a‑1, agregar `@@index([fkColumn, …])` si se filtra por ese par

---

## 5. Integraciones externas

> Una subsección por servicio externo (Jira, Google, IA, etc.).

### 5.1. `<servicio>`

- **Doc oficial:** `<URL>` — `<disponible \| pendiente del cliente>`
- **Cliente / SDK:** `<nombre lib o "fetch nativo">` — versión `<x.y.z>`
- **Endpoints consumidos:**
  - `<MÉTODO> <path>` — para …
- **Autenticación:** `<OAuth2 \| API Token \| Bearer …>`
- **Almacenamiento de credenciales:** `process.env.<VAR>` — si es token de
  usuario, **debe** persistirse cifrado con `shared/utils/crypto.js#encrypt`.
- **Manejo de errores:**
  - Timeout: `<ms>` — debe loguearse con `logger.warn` y devolver 502.
  - 401: refrescar token (si aplica) o invalidar sesión.
  - 5xx: `<retry con backoff \| fallar rápido>`.
- **Rate limits conocidos:** …

#### Estrategia para avanzar sin doc oficial del cliente

> Aplica cuando la doc específica del cliente todavía no llegó (ej: Finegans).

- [ ] El código contra el servicio se aísla en un **adapter** dentro del
      service (`src/modules/<name>/<name>.<servicio>.client.js`).
- [ ] El adapter recibe configuración por DI / env vars: `BASE_URL`,
      `PROJECT_KEY`, `FIELD_MAPPING`, etc. **No** se hardcodean valores del
      sandbox personal.
- [ ] Los tests mockean el adapter (no `fetch` directo) — esto blinda los
      unit tests del cambio cuando llegue la doc oficial.
- [ ] Lista explícita de **supuestos a validar** cuando llegue la doc:

  | Supuesto                                          | Validación al recibir doc |
  | ------------------------------------------------- | ------------------------- |
  | `<ej: campo de estimación es cf[10016]>`          | …                         |

---

## 6. Configuración y variables de entorno

| Variable             | Requerida | Tipo / Formato       | Descripción                      | Default |
| -------------------- | --------- | -------------------- | -------------------------------- | ------- |
| `<EJ_VAR>`           | sí        | string               | …                                | —       |
| `<EJ_API_TOKEN>`     | sí        | string (secreta)     | …                                | —       |
| `<EJ_BASE_URL>`      | sí        | URL                  | …                                | —       |

> Validación: si una env var es requerida, fallar al **boot** con un mensaje
> claro (patrón en `google.service.js`: `throw new Error('… is required')`).
> No leer envs dentro de funciones que se ejecutan por request.

> Secretos nunca se loguean. Confirmar que no aparecen en `requestLogger`
> ni en payloads de error.

---

## 7. Seguridad

- [ ] **Autenticación:** las rutas no públicas pasan por middleware de auth.
- [ ] **Autorización:** chequeo de `role` (`EMPLOYEE` / `ADMIN`) en controller
      o middleware dedicado, no en el service.
- [ ] **Sanitización de input:** uso de `shared/utils/sanitize.js` para
      strings provenientes del cliente.
- [ ] **Cifrado en reposo:** tokens de terceros (refresh, API tokens) se
      persisten cifrados con AES‑256‑GCM (`shared/utils/crypto.js`). Verificar
      que `ENCRYPTION_KEY` esté seteada en todos los entornos.
- [ ] **CORS:** revisar `app.js` — el TODO de restringir orígenes aplica
      antes de prod.
- [ ] **Secret scanning:** ningún secreto real en repo. El `.gitleaksignore`
      solo cubre keys de test documentadas.
- [ ] **OWASP Top 10 relevantes:** indicar cuáles aplican y cómo se mitigan
      (ej: SQLi → Prisma parametriza; XSS → no aplica en API JSON; SSRF →
      validar URLs antes de llamar a servicios externos).

---

## 8. Logging y observabilidad

- Logger: `shared/utils/logger.js` (winston). Nunca `console.log`.
- Niveles esperados:
  - `info` — eventos de negocio relevantes (login OK, reporte aprobado).
  - `warn` — situaciones recuperables (retry, fallback).
  - `error` — errores que llegan al `errorHandler` o que rompen un flujo.
- Estructura: pasar metadata como segundo argumento (`logger.error('msg', { error, userId })`).
- Datos a **excluir** de los logs: tokens, refresh tokens cifrados, payloads
  con PII completa, contraseñas (no aplica hoy pero documentado).

---

## 9. Manejo de errores

- Errores tipados cuando agregan información (ver `InvalidCiphertextError`).
- Mensajes en español, consistente con el código existente.
- Encadenar causa con `new Error('msg', { cause: error })`.
- El `errorHandler` global mapea a status code; **no** atrapar y devolver
  `res.status(500)` desde el controller a mano.

---

## 10. Testing

> Política del repo: `coverageThreshold` en `package.json` exige
> **lines / branches / functions / statements ≥ 80%** global.
> Un PR cuyo diff baje el coverage debe agregar tests antes de mergear.

### 10.1. Ubicación

```
tests/modules/<name>/<name>.service.test.js
tests/modules/<name>/<name>.controller.test.js   ← si la lógica de adaptación lo amerita
tests/shared/<area>/<file>.test.js                ← para utils nuevas
```

### 10.2. Convenciones (heredadas de `users.service.test.js`)

- `jest.mock(...)` para Prisma y para clientes externos.
- `beforeEach(() => jest.clearAllMocks())`.
- Un `describe` por unidad bajo prueba; un `test` por escenario observable.
- Aserciones explícitas sobre **argumentos** pasados a Prisma / clientes
  (`expect(...).toHaveBeenCalledWith(...)`), no solo sobre el retorno.

### 10.3. Casos mínimos a cubrir

Por cada función exportada del service:

- [ ] Happy path (todos los inputs válidos).
- [ ] Cada validación de input (cada `throw` propio).
- [ ] Cada modo de fallo del cliente externo / DB (`mockRejectedValue`).
- [ ] Normalización / transformación de datos (lowercase, trim, mapping).
- [ ] Side effects verificables (logs, encrypt/decrypt, llamadas a otros services).

### 10.4. Mapeo HU ↔ test

> Cada escenario Gherkin del documento funcional debe corresponderse con
> al menos un `test(...)`. Pegar la tabla acá al cerrar el doc.

| Escenario funcional | Archivo de test | Nombre del test |
| ------------------- | --------------- | --------------- |
| HU‑01 happy path    | `<…>.test.js`   | `…`             |
| HU‑01 error de auth | `<…>.test.js`   | `…`             |

### 10.5. Coverage local

```bash
npm run test:coverage
```

> Si la feature toca código que el repo excluye del coverage (`server.js`,
> `app.js`, `prisma.js`, `logger.js`, `*.dto.js`, `*.constants.js`,
> `*.config.js`, `**/index.js`), justificar acá por qué entra/no entra.

---

## 11. Performance y límites

- **Queries N+1:** revisar uso de `include`/`select` en Prisma.
- **Índices necesarios:** listar y agregar a `schema.prisma` (`@@index`).
- **Paginación:** endpoints que listan colecciones deben paginar
  (definir `limit`, `cursor` o `page`).
- **Timeouts a servicios externos:** explícitos, nunca infinitos.

---

## 12. Despliegue y operaciones

- **Migraciones:** `npx prisma migrate deploy` antes del start del proceso.
- **Compatibilidad hacia atrás:** si la feature está detrás de una env var,
  documentar el rollout.
- **Rollback:** describir cómo revertir (migración inversa, feature flag).
- **Healthcheck:** confirmar que `/health` sigue verde tras el deploy.

---

## 13. CI / Pipeline

> Definido en `.github/workflows/ci.yml`. La feature debe pasar:

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:coverage` (≥ 80% global)
- [ ] `pr-guard.yml`, `security.yml`, `codeql.yml` sin findings nuevos
- [ ] Sin secretos detectados por gitleaks

---

## 14. Riesgos técnicos y mitigaciones

| Riesgo                                                                    | Probabilidad | Impacto | Mitigación |
| ------------------------------------------------------------------------- | ------------ | ------- | ---------- |
| `<ej: la doc oficial de Finegans difiere del sandbox personal>`           | media        | alto    | adapter aislado + tabla de supuestos en §5 |
| `<ej: rate limit de Jira en sync masivo>`                                 | …            | …       | …          |

---

## 15. Tareas de implementación (checklist sugerida)

> Útil para abrir tickets y para el PR.

- [ ] Modelo Prisma + migración
- [ ] Service con lógica de negocio
- [ ] Adapter / cliente externo (si aplica)
- [ ] Controller + routes
- [ ] Wire-up en `src/app.js`
- [ ] Tests de service (happy + errores) — coverage ≥ 80% local
- [ ] Tests de utilidades nuevas
- [ ] Variables de entorno en `.env.example` (si existe) y documentadas en §6
- [ ] Validación de configuración al boot
- [ ] Logs estructurados con winston
- [ ] Documento funcional actualizado con el mapeo HU ↔ test (§10.4)
- [ ] CHANGELOG si el PR va a `main`
- [ ] PR template completado

---

## 16. Open questions técnicas

- [ ] `<#1>`
- [ ] `<#2>`
