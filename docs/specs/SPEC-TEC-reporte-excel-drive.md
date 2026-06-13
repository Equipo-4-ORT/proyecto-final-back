# SPEC-TEC (Técnica) — Google Sheet del reporte diario guardado en Drive

> Especificación **técnica**. Describe **cómo** se implementa lo que define la [spec funcional](./SPEC-reporte-excel-drive.md): diseño, contratos, datos, errores y plan de cambio.

| | |
|---|---|
| **Feature ID** | `F7-01` (tentativo) |
| **Estado** | Implementada |
| **Fecha** | 2026-06-13 |
| **Autor(es)** | Equipo 4 |
| **Spec funcional** | [SPEC-reporte-excel-drive](./SPEC-reporte-excel-drive.md) |
| **ADR relacionado** | ninguno |
| **Módulo destino** | `src/modules/reports/` |
| **Stack relevante** | Express 5, Prisma, `googleapis` (Sheets API v4), `google-auth-library`, Winston |

---

## 1. Resumen técnico

Tras generar y persistir el contenido del reporte, el `reports.service` crea un **Google Sheet nativo** en el Drive del empleado mediante la **Sheets API v4** (`spreadsheets.create`), usando el `OAuth2Client` ya autenticado con el refresh token de Google del usuario. Se eligió Sheet nativo sobre `.xlsx` binario porque se resuelve con el scope `spreadsheets` **ya otorgado** (sin re-consentimiento ni scope `drive.file`) y sin librerías nuevas. La escritura de valores usa `valueInputOption: RAW`, que neutraliza estructuralmente la formula injection.

## 2. Contexto y restricciones

- **Arquitectura vigente:** monolito modular, capas controller → service (ver [ADR-002](../adr/ADR-002-arquitectura-monolito-modular.md)).
- **Restricciones técnicas:** una sola instancia, self-hosted, Node 20+. El proveedor de IA es multi-tenant (ver [ADR-003](../adr/ADR-003-adapter-pattern-ia.md)); esta feature no lo toca.
- **Convenciones del repo a respetar:** errores tipados con `statusCode`, logger Winston estructurado (sin PII), refresh token de Google descifrado vía `getDecryptedRefreshToken`, cliente Google vía `getAuthenticatedGoogleClient`.
- **Lo que NO se puede romper:**
  - Contrato actual de `POST /reports/generate` consumido por el front (el cambio es **aditivo**: se agrega `xlsxUrl`).
  - Esquema de BD: `Report.xlsxUrl` ya existe (`VarChar(255)`), sin migración.
  - Scopes OAuth: NO se agrega `drive.file`; se usa `spreadsheets` ya presente en `auth.service.js`.

## 3. Diseño de la solución

El Sheet se crea como un **paso posterior y no bloqueante** a la persistencia del reporte: si falla, el reporte queda igualmente generado en `PENDING` con `xlsxUrl = null` (degradación, RN-06).

> **Nota sobre formula injection:** los adapters de IA (OpenAI/Gemini) ya aplican `sanitizeObjectForExcel` al output, que prefija un apóstrofo a todo string que empiece con `=`/`+`/`-`/`@`. Por eso se escribe con `valueInputOption: USER_ENTERED`: el apóstrofo inicial fuerza el valor a texto y **no se muestra** en la celda, neutralizando la fórmula. La defensa es ese escape preexistente; `USER_ENTERED` además mantiene `totalHours`/`duration` como números reales en el Sheet.

```
generateReportForDate(user, dateStr)
  │
  ├─ (flujo actual) valida fecha · idempotencia (SENT/PENDING) · busca actividades
  │                 · checkOverlaps · IA.generateSummary → aiOutput
  │
  ├─ persiste Report (status PENDING, content=aiOutput)      ← punto de "reporte generado"
  │
  └─ createReportSheet(user, savedReport, aiOutput)          ← NUEVO, best-effort
        │
        ├─ getDecryptedRefreshToken(user.id) ─ null? → log + return (xlsxUrl queda null)
        ├─ getAuthenticatedGoogleClient(refreshToken)
        ├─ sheets = google.sheets({ version: 'v4', auth })
        ├─ spreadsheets.create({ properties.title = dateStr })       → spreadsheetId + URL
        ├─ spreadsheets.values.update(range A1, USER_ENTERED, values) → header + tabla + total
        │     (el apóstrofo del adapter fuerza texto, no se muestra)
        ├─ Report.update({ xlsxUrl: spreadsheetUrl })
        └─ catch:
              ├─ auth error (invalid_grant / 401 / 400) → markGoogleReconnect(user.id)
              └─ cualquier otro → log.warn; xlsxUrl queda null
```

> **Reintento (§13.7):** el camino idempotente de "borrador `PENDING` recuperado" devuelve el reporte sin llamar a la IA; si además detecta `xlsxUrl = null`, invoca `createReportSheet` antes de responder. Así un fallo previo de Sheet se recupera con un nuevo `POST /reports/generate` del mismo día, sin tocar la unicidad ni recalcular el contenido.

**Componentes:**
| Componente | Responsabilidad | Nuevo / Modificado |
|---|---|---|
| `reports.controller.js` | Devuelve `xlsxUrl` en la respuesta de `generateReport` (ya hace `res.json(result)`; el campo viaja solo). | Sin cambios |
| `reports.service.js` | Orquesta: tras persistir, invoca la creación del Sheet y guarda `xlsxUrl`. | Modificado |
| `reports.sheet.js` (helper nuevo) | Arma el layout del Sheet y llama a la Sheets API; aísla `googleapis` del service. | Nuevo |
| `shared/utils/refreshToken.js` | `getDecryptedRefreshToken` (reutilizado). | Sin cambios |
| `google.service.js` | `getAuthenticatedGoogleClient` (reutilizado). | Sin cambios |

> El helper `reports.sheet.js` mantiene a `reports.service` agnóstico de la Sheets API, espejando cómo `drive-activity.service` encapsula `googleapis`.

## 4. Contrato de API

### `POST /reports/generate`
- **Auth:** JWT requerido (`authMiddleware` + `requireActiveUser`).
- **Rate limit:** `apiLimiter` (sin cambios).
- **Request body** (sin cambios):
```json
{ "date": "YYYY-MM-DD" }
```
- **Respuestas** (el único cambio es el campo `xlsxUrl`, **aditivo**):

| Código | Cuándo | Body |
|---|---|---|
| `200` | Reporte generado (o borrador/SENT recuperado). | `{ message, report, preview, hasOverlaps, xlsxUrl }` — `xlsxUrl: string \| null` |
| `400` | `date` ausente/ inválida, o sin actividades. | `{ error }` (sin cambios) |
| `401` | Sin auth / token inválido. | `{ error }` (sin cambios) |
| `409` | Solapamientos (`OverlapsDetectedError`). | `{ error, hasOverlaps: true }` (sin cambios) |
| `5xx` | Error interno (NO por fallo de Sheets: ese degrada a `xlsxUrl: null`). | `{ error }` mensaje genérico |

> **Importante:** un fallo creando el Sheet **no** cambia el status HTTP: la respuesta sigue siendo `200` con `xlsxUrl: null`. El front decide si mostrar el enlace según ese campo.

## 5. Modelo de datos

- **Tablas/modelos afectados (Prisma):** `Report`.
- **Cambios de esquema:** **ninguno.** El campo `xlsxUrl String? @db.VarChar(255) @map("xlsx_url")` ya existe.
- **Qué se guarda:** el `spreadsheetUrl` que devuelve `spreadsheets.create` (`https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit`, ~52 + id ≈ 90 chars), holgadamente dentro de `VarChar(255)`.
- **Idempotencia / unicidad:** el unique `@@unique([userId, reportDate])` garantiza un reporte (y un Sheet) por día. La creación del Sheet ocurre en el camino donde el reporte se genera por primera vez; en los caminos idempotentes (`SENT`, borrador `PENDING` recuperado) **no** se recrea, salvo la excepción de reintento: si un borrador `PENDING` recuperado tiene `xlsxUrl = null` (la creación falló antes), se reintenta crear el Sheet y se persiste la URL (decisión §13.7).

## 6. Dependencias externas e integraciones

| Dependencia | Uso | Modo de fallo | Manejo |
|---|---|---|---|
| Google Sheets API v4 (`spreadsheets.create` + `spreadsheets.values.update`) | Crear el Sheet (título) y escribir el contenido con `USER_ENTERED`. | timeout / 5xx / 429 rate limit | `try/catch`: log.warn, `xlsxUrl` queda `null`, reporte queda `PENDING`. No reintento en línea (el usuario reintenta). |
| Google OAuth (`getAuthenticatedGoogleClient`) | Autenticar al usuario dueño. | `invalid_grant` / 401 / 400 (token revocado) | `markGoogleReconnect(userId)` → `googleReconnectRequired = true`; `xlsxUrl` null. |

- **Timeouts y reintentos:** se delega en el default del cliente `googleapis`. No se agrega retry en línea para no alargar la respuesta del endpoint (el endpoint ya hizo la llamada cara a la IA).
- **Rate limits / cuotas:** una creación por reporte/día; volumen bajo. No requiere throttling propio.
- **Detección de error de auth:** `looksLikeGoogleAuthError` y `markGoogleReconnect` se extraen a `shared/utils/googleAuthError.js` (hoy viven en `scheduler/userSync.service.js`) y los reusan scheduler y reports (decisión §13.6). La detección recorre la cadena de `cause` buscando `invalid_grant` / status 400 / 401.

## 7. Manejo de errores y estados de fallo

| Escenario | Detección | Respuesta al cliente | Log / efecto |
|---|---|---|---|
| `date` inválida / sin actividades | flujo actual (`ReportValidationError`) | `400` | sin cambios |
| Solapamientos | `OverlapsDetectedError` | `409` | sin cambios |
| Usuario sin refresh token de Google | `getDecryptedRefreshToken` → `null` | `200`, `xlsxUrl: null` | `log.info` (no es error: el reporte vale igual) |
| Token de Google revocado | `invalid_grant` / 401 / 400 en la llamada | `200`, `xlsxUrl: null` | `log.warn` + `markGoogleReconnect(userId)` |
| Sheets API caída / 5xx / 429 / timeout | `catch` en `createReportSheet` | `200`, `xlsxUrl: null` | `log.warn` con `reportId`, `userId`, `code` |
| Excepción no controlada **antes** de persistir el reporte | error handler del controller | `500` genérico | `log.error` con stack, sin PII |

> Regla: el cliente nunca recibe stack traces. La creación del Sheet es **best-effort** y aislada en su propio `try/catch`; jamás tumba un reporte ya persistido.

## 8. Consideraciones de seguridad

| ID | Control | Implementación |
|---|---|---|
| **SEC-01** | **AuthN** | `authMiddleware` ya aplicado en la ruta; sin token → `401`. |
| **SEC-02** | **AuthZ (horizontal)** | El Sheet se crea con el `OAuth2Client` del `req.user`; el destino es **su** Drive. No se lee `userId`/destino del body. |
| **SEC-03** | **Validación de input** | `date` validada (flujo actual). Contenido escrito ya pasó la sanitización del pipeline de IA. |
| **SEC-04** | **Formula injection** | Los adapters de IA ya escapan el output con apóstrofo (`sanitizeObjectForExcel`). Se escribe con **`valueInputOption: USER_ENTERED`**: el apóstrofo inicial fuerza texto y no se muestra en la celda → la fórmula no se evalúa. **Depende** de que el contenido escrito provenga del output ya escapado del adapter (lo cumple, viene de `Report.content`). Ver §13.3. |
| **SEC-05** | **Secretos y tokens** | Refresh token descifrado solo en memoria; nunca se loguea ni se devuelve. El `spreadsheetUrl` guardado no contiene tokens. |
| **SEC-06** | **Datos sensibles en logs** | Logs con `userId`, `reportId`, `code`; nunca el contenido del reporte ni PII. |
| **SEC-07** | **Rate limiting** | `apiLimiter` actual; una creación por día por la unicidad del reporte. |
| **SEC-09** | **Errores seguros** | Fallo de Sheets degrada silencioso (`xlsxUrl: null`), sin filtrar detalles de la API externa al cliente. |

## 9. Casos borde técnicos

| ID | Caso | Manejo técnico |
|---|---|---|
| **ET-01** | Doble submit / regeneración del mismo día | Unique `[userId, reportDate]` + caminos idempotentes (`SENT`/borrador) que devuelven el `xlsxUrl` existente sin crear Sheet nuevo. |
| **ET-02** | Reporte persiste OK pero falla la creación del Sheet | `xlsxUrl` queda `null`; el reporte es válido. Al volver a pedir `generate` ese día, el camino de borrador `PENDING` recuperado detecta `xlsxUrl = null` y reintenta crear el Sheet, sin violar `[userId, reportDate]` (decisión §13.7). |
| **ET-03** | Día con muchas filas | Una sola escritura (`values.update`) con todas las `rows`; volumen humano acotado. Sin paginación necesaria. |
| **ET-04** | `rows` vacío | No ocurre: el flujo aborta con `400` antes si no hay actividades. |
| **ET-05** | Sheets lenta/caída | `try/catch` aísla; no bloquea la respuesta más allá del timeout del cliente `googleapis`. |
| **ET-06** | Unicode / emojis en celdas | La Sheets API acepta UTF-8; se escriben tal cual. |
| **ET-07** | Proceso reiniciado entre persistir y crear el Sheet | El reporte queda `PENDING` con `xlsxUrl null`; consistente con el caso de fallo (recuperable por reintento). |

## 10. Scope de cambio

**Archivos / módulos nuevos:**
- `src/modules/reports/reports.sheet.js` — arma el layout y llama a `spreadsheets.create` (encapsula `googleapis`).
- `src/shared/utils/googleAuthError.js` — `looksLikeGoogleAuthError` + `markGoogleReconnect`, extraídos del scheduler para compartirlos (decisión §13.6).

**Modificados:**
- `src/modules/reports/reports.service.js` — tras `prisma.report.create/update`, invocar `createReportSheet` (best-effort) y persistir `xlsxUrl`; devolverlo en el resultado. En el camino de borrador `PENDING` recuperado con `xlsxUrl = null`, reintentar la creación del Sheet (decisión §13.7).
- `src/modules/scheduler/userSync.service.js` — pasa a importar `looksLikeGoogleAuthError`/`markGoogleReconnect` del nuevo util compartido (mantiene su comportamiento y el re-export; refactor de bajo riesgo).

> `reports.controller.js` **no** requirió cambios: ya hace `res.status(200).json(result)` y el `xlsxUrl` viaja dentro de `result`.

**Esquema / migraciones:**
- Ninguna (`Report.xlsxUrl` ya existe).

**Configuración / env nuevas:**
- Ninguna obligatoria. (El destino es la raíz del Drive; no hay carpeta configurable en este alcance.)

**NO se toca (y por qué):**
- `auth.service.js` / scopes OAuth — `spreadsheets` ya otorgado alcanza.
- Pipeline de IA y su sanitización — fuera de alcance.
- `getReportsHistory` / `GET /reports` — ya devuelve `xlsxUrl`; el front lo consume sin cambios.

**Breaking changes / coordinación con el front:**
- Ninguno. `xlsxUrl` es aditivo; el front debe contemplar `xlsxUrl: null` (reporte sin Sheet) para no mostrar enlace.

## 11. Plan de testing

| Tipo | Qué cubre | Casos clave |
|---|---|---|
| **Unitario** | `reports.sheet.js`: arma el payload correcto (título=fecha, header=`daySummary`, filas en orden, `totalHours` incluido) y usa `valueInputOption: USER_ENTERED`. | CA-01, CA-03, RN-03 |
| **Unitario** | `reports.service`: tras persistir, llama a `createReportSheet`; ante fallo, el reporte queda `PENDING` con `xlsxUrl null` (no propaga la excepción). | CA-05, RN-06, ET-02 |
| **Unitario** | Camino idempotente: reporte `SENT`/borrador con `xlsxUrl` ya seteado no crea Sheet nuevo y devuelve el existente. | CA-04, ET-01 |
| **Unitario** | Reintento: borrador `PENDING` recuperado con `xlsxUrl null` reintenta `createReportSheet` y persiste la URL si sale OK; no recalcula la IA. | §13.7, ET-02 |
| **Integración** | `POST /reports/generate` con Sheets API **mockeada**: respuesta `200` incluye `xlsxUrl`; con mock que falla → `200` con `xlsxUrl null`. | CA-01, CA-05 |
| **Seguridad** | Token revocado → `markGoogleReconnect` invocado; el `userId` del Sheet es el del token (no del body). | SEC-02, SEC-04 |
| **Formula injection** | Un campo que el adapter escapó (`'=...`) se escribe con `USER_ENTERED`; la celda muestra el texto sin apóstrofo y la fórmula no se evalúa. | SEC-04, CA-03 |

- **Cobertura objetivo:** respetar el threshold del repo (80% lines/branches/functions/statements).
- **Datos / mocks:** mockear `googleapis` (`google.sheets`) y `getAuthenticatedGoogleClient`/`getDecryptedRefreshToken`, igual que los tests existentes de Drive/Calendar.

## 12. Cuestiones abiertas

Ninguna pendiente — las tres se resolvieron y se migraron a §13 (decisiones 6, 7 y 8).

## 13. Decisiones técnicas tomadas

1. **Sheet nativo vía Sheets API v4** en lugar de `.xlsx` binario — usa el scope `spreadsheets` ya otorgado, sin librería de Excel ni scope `drive.file` — *2026-06-13, equipo.*
2. **Creación best-effort, aislada en `try/catch`** — un fallo deja `xlsxUrl null` y NO cambia el `200`; el reporte ya persistido es la fuente de verdad — *2026-06-13, equipo (RN-06).*
3. **Escritura con `valueInputOption: USER_ENTERED`, reutilizando el escape de apóstrofo que ya aplican los adapters** (`sanitizeObjectForExcel`). Verificado que OpenAI ([openai.adapter.js:112](../../src/modules/ai/adapters/openai.adapter.js#L112)) y Gemini ([gemini.adapter.js:124](../../src/modules/ai/adapters/gemini.adapter.js#L124)) lo aplican al output. Se descartó tocar los adapters para mantener el blast radius mínimo — *2026-06-13, equipo.* **Artefacto conocido (fuera de alcance):** ese apóstrofo también queda en `Report.content`, por ende en el `preview` del front y en el `daySummary` del email; es preexistente y no lo aborda esta feature.
4. **Destino: raíz de "Mi unidad"** del empleado, sin carpeta (evita `drive.file`) — *2026-06-13, equipo.*
5. **Se persiste `spreadsheetUrl`** en `Report.xlsxUrl`; sin migración — *2026-06-13, equipo.*
6. **Reuso del detector de error de auth de Google:** se **extraen** `looksLikeGoogleAuthError` y `markGoogleReconnect` desde `scheduler/userSync.service.js` a `shared/utils/googleAuthError.js`, y los consumen tanto el scheduler como reports. Evita duplicar la lógica de detección por cadena de `cause` y el marcado de `googleReconnectRequired` — *2026-06-13, equipo.*
7. **Reintento tras fallo de Sheet (simple):** en el camino idempotente de "borrador `PENDING` recuperado", si el reporte tiene `xlsxUrl = null`, se reintenta crear el Sheet (y se persiste la URL si sale bien). Reusa el flujo existente sin endpoint nuevo ni violar `[userId, reportDate]`; el `preview`/IA no se recalcula — *2026-06-13, equipo.*
8. **Layout en `spreadsheets.create` (título) + `spreadsheets.values.update` (`USER_ENTERED`):** dos llamadas porque `create` no acepta `valueInputOption` y `USER_ENTERED` es necesario para que el apóstrofo del adapter se interprete como texto. Encabezado con `daySummary`, tabla de `rows` por hora y `totalHours` **incluido** (ya está en el contenido y aporta el cierre del día; consistente con la spec funcional CA-01). Sin `batchUpdate` ni formato avanzado (congelar fila, estilos) en este alcance — *2026-06-13, equipo.*

## 14. Riesgos y mitigaciones

| Riesgo | Impacto | Probabilidad | Mitigación |
|---|---|---|---|
| El adapter de IA ya escapa fórmulas con apóstrofo | bajo | — | **Resuelto:** se escribe con `USER_ENTERED`, que consume ese apóstrofo (lo trata como texto, no lo muestra). Test de formula injection que afirma que la celda muestra el texto sin `'` y la fórmula no se evalúa. |
| Llega al Sheet contenido NO escapado (bypass del adapter) → fórmula evaluada con `USER_ENTERED` | medio | baja | El único contenido escrito proviene de `Report.content` (output del adapter, ya escapado). No introducir otras fuentes de texto en el Sheet sin escaparlas. |
| Latencia agregada por la llamada a Sheets en el endpoint | bajo | media | Llamada única, sin retry en línea; medir y, si molesta, evaluar moverla a async (fuera de este alcance). |
| Cuota de Sheets API en picos | bajo | baja | Una creación por reporte/día; volumen humano. |
| Reintento tras fallo choca con el unique del reporte | bajo | baja | **Resuelto:** el reintento va por el camino de borrador `PENDING` recuperado (no crea reporte nuevo); solo actúa si `xlsxUrl` es `null` (decisión §13.7). |

## 15. Plan de rollout y rollback

- **Despliegue:** deploy back (sin migración) → el front contempla `xlsxUrl` (puede desplegarse antes, el campo ya existe y hoy va `null`).
- **Backfill:** no hay; los reportes previos quedan con `xlsxUrl null` (sin enlace en el historial).
- **Rollback:** revertir el deploy del back; no hay cambios de esquema que deshacer. Los Sheets ya creados quedan en los Drives de los usuarios (inocuos).
- **Observabilidad post-deploy:** ratio de reportes con `xlsxUrl` no nulo vs. total; logs `log.warn` de fallo de creación; alza de `googleReconnectRequired`.

## 16. Referencias

- Spec funcional: [SPEC-reporte-excel-drive](./SPEC-reporte-excel-drive.md).
- Flujo actual: `src/modules/reports/reports.service.js` (`generateReportForDate`).
- Contrato de salida de IA y nota de formula injection: `src/modules/ai/ai.output.types.js`, `src/modules/ai/ai.interface.js` (item 6).
- Sanitización Excel existente (apóstrofo): `src/modules/ai/ai.sanitize.js` (`sanitizeForExcel`).
- Patrón de cliente Google + token: `src/modules/drive/drive-activity.controller.js`, `src/shared/utils/refreshToken.js`, `src/modules/google/google.service.js`.
- Detección de error de auth de Google: `src/modules/scheduler/userSync.service.js` (`looksLikeGoogleAuthError`, `markGoogleReconnect`).
- Modelo `Report`: `prisma/schema.prisma`.
