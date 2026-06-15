# PLAN — Tracking de actividad de Drive fuera de "Mi unidad"

> Plan técnico derivado de la [SPEC funcional](./SPEC-drive-tracking-fuera-mi-unidad.md). Describe **cómo** ampliar la recolección de actividad de Drive a Unidades compartidas y "Compartido conmigo", atribuyendo solo el trabajo del propio empleado. El **qué** y el **por qué** están en la SPEC.

| | |
|---|---|
| **Feature ID** | F-DRIVE-02 |
| **Fecha** | 2026-06-15 |
| **Rama** | `fix/drive-tracking-outside-my-unit` |
| **Módulo destino** | `src/modules/drive/` |
| **Depende de** | SPEC F-DRIVE-02 aprobada |

---

## 1. Enfoque

Hoy [`getDriveActivitiesForDay`](../../src/modules/drive/drive-activity.service.js) lanza el set de queries de la Drive Activity API **sin `ancestorName` ni `itemName`**, por lo que cae en el default `items/root` (solo "Mi unidad"). El fix tiene tres movimientos:

1. **Enumerar el alcance** del empleado: "Mi unidad" (`items/root`) + cada **unidad compartida** (`drives.list` → `items/{driveId}`) + cada **archivo "Compartido conmigo"** (`files.list` con `sharedWithMe = true` → `items/{fileId}`).
2. **Parametrizar la consulta** existente por *scope*: el mismo set de queries (principal + por acción, con consolidación legacy) se ejecuta contra cada scope, con concurrencia acotada, y los resultados se **unen y deduplican**.
3. **Filtrar por actor**: quedarse solo con las actividades cuyo actor es el usuario actual (`actor.user.knownUser.isCurrentUser === true`), descartando las de otros colaboradores.

El **contrato externo de `persistDriveActivities` no cambia** (misma firma y retorno). No hay cambios de esquema ni de scopes. El resto del pipeline (`extractDriveTarget`, `buildWorkEstimates`, upsert idempotente) se reutiliza intacto.

## 2. Stack y piezas reutilizables

| Pieza existente | Uso en el fix |
|---|---|
| `getAuthenticatedGoogleClient(refreshToken)` | Cliente OAuth ya autenticado (sin cambios). |
| `google.driveactivity({version:'v2'})` | Consulta de actividad — ahora con `ancestorName`/`itemName`. |
| `google.drive({version:'v3'})` | **Nuevo uso para enumerar**: `drives.list` y `files.list`. Ya se usa en `enrichDriveActivitySummary`. |
| `queryDriveActivityPaginated` | Paginación de cada query (sin cambios; se le pasa el scope en el `requestBody`). |
| `extractDriveTarget`, `buildWorkEstimates`, `EXCLUDED_MIME_TYPES` | Parseo, estimación y exclusiones (sin cambios). |
| `mapWithConcurrency` (`shared/utils/concurrency.js`) | Acotar la concurrencia del fan-out por scope y de la consulta por ítem. |
| Upsert idempotente sobre `userId_source_externalId` | Persistencia (sin cambios; `externalId` ya basa en `fileId`). |
| `logger` (Winston) | Logs estructurados por scope (RNF-03). |

## 3. Dependencias y configuración nuevas

- **npm:** ninguna (todo con `googleapis` ya instalado).
- **Scopes Google:** ninguno nuevo (`drive.activity.readonly`, `drive.metadata.readonly`, `drive` ya otorgados — verificado en `auth.service.js`).
- **Esquema/migración:** ninguno (el `externalId` por `fileId` absorbe los nuevos archivos).
- **Constantes nuevas en `drive-activity.service.js`:**
  | Constante | Descripción | Default sugerido |
  |---|---|---|
  | `SCOPE_CONCURRENCY` | Scopes (unidad/ítem) consultados en paralelo contra la Activity API. | `5` |
  | `SHARED_WITH_ME_PAGE_SIZE` | `pageSize` de `files.list` para "Compartido conmigo". | `100` |
  | `MAX_SHARED_ITEMS` | Tope defensivo de archivos "Compartido conmigo" a consultar por ventana (corta colas absurdas). | `500` |

  > Si se decide exponerlas por env, agregar getters en `shared/config`; por defecto van como constantes del módulo (mismo patrón que `ENRICH_CONCURRENCY`).

## 4. Estructura de archivos

**Modificados**
```
src/modules/drive/drive-activity.service.js
  - getDriveActivitiesForDay        ← parametrizar por scope + unir/dedupe + filtro de actor
  - (nuevas funciones internas)     ← runActivityQueriesForScope, isCurrentUserActivity
src/modules/drive/drive-scope.service.js   (NUEVO)
  - listSharedDriveScopes(refreshToken)     → [{ ancestorName }]  (drives.list)
  - listSharedWithMeScopes(refreshToken)    → [{ itemName }]      (files.list, sharedWithMe)
  - buildDriveScopes(refreshToken)          → [ {ancestorName:'items/root'}, ...drives, ...sharedWithMe ]
```
**Tests**
```
tests/modules/drive/drive-activity.service.test.js   ← extender (CA-01..CA-09)
tests/modules/drive/drive-scope.service.test.js      ← NUEVO (enumeración + tolerancia a fallos)
```

> El split en `drive-scope.service.js` aísla la enumeración (Drive API v3) de la consulta de actividad (Activity API v2) y facilita el mock en tests. Si se prefiere no crear archivo, las funciones pueden vivir como helpers internos de `drive-activity.service.js`.

## 5. Tareas

| ID | Tarea | Archivos | Cubre (SPEC) |
|---|---|---|---|
| **T-01** | **Enumeración de scopes.** `listSharedDriveScopes`: `drive.drives.list({ pageSize:100, fields:'nextPageToken,drives(id)' })` paginado → `{ ancestorName: 'items/'+id }`. `listSharedWithMeScopes`: `drive.files.list({ q:"sharedWithMe = true and trashed = false", fields:'nextPageToken,files(id,mimeType)', supportsAllDrives:true, includeItemsFromAllDrives:true, pageSize:SHARED_WITH_ME_PAGE_SIZE })` paginado, **excluyendo `EXCLUDED_MIME_TYPES`** y topeando en `MAX_SHARED_ITEMS` → `{ itemName: 'items/'+id }`. `buildDriveScopes`: `[{ancestorName:'items/root'}, ...drives, ...sharedWithMe]`. Cada enumeración aísla su error (try/catch → log + `[]`). | `drive-scope.service.js` | RN-D01/D05, V-03, CU-01 paso 2 |
| **T-02** | **Query por scope.** Extraer el cuerpo actual de `getDriveActivitiesForDay` (query principal + N por acción + dedupe local por `fileId+actionType`) a `runActivityQueriesForScope(driveactivity, scope, timeFilter)`, donde `scope` es `{ancestorName}` o `{itemName}` y se inyecta en cada `requestBody`. | `drive-activity.service.js` | RN-D01, causa raíz §14.1 |
| **T-03** | **Fan-out por scope + unión global.** En `getDriveActivitiesForDay`: armar `scopes` (T-01), ejecutar `runActivityQueriesForScope` por scope con `mapWithConcurrency(scopes, SCOPE_CONCURRENCY, …)`, aplanar resultados y **deduplicar globalmente** por clave estable (`fileId + actionType + timestamp/timeRange`) para evitar inflar intervalos cuando un archivo aparece en más de un scope. Un scope que falla → log + se omite (no aborta). | `drive-activity.service.js` | RN-D01/D04/D05, E-03/E-07 |
| **T-04** | **Filtro de actor.** `isCurrentUserActivity(activity)` → `activity.actors?.some(a => a.user?.knownUser?.isCurrentUser === true)`. Aplicarlo a las actividades crudas antes de devolverlas (o como filtro previo al `byFile` en `persistDriveActivities`). Descarta sistema/anónimos/otros usuarios. **Aplica a todos los scopes, incluido `items/root`.** | `drive-activity.service.js` | RN-D02/D03, V-02, E-02/E-04/E-09 |
| **T-05** | **Observabilidad.** Logs estructurados: `drive.scope.enumerated` (conteo de unidades/ítems), `drive.scope.queried` (crudas por scope), `drive.actor.filtered` (descartadas por actor), `drive.scope.skipped` (scope/ítem omitido + motivo), `drive.persist.done` (created/updated). Solo `userId`/`fileId`. | `drive-activity.service.js`, `drive-scope.service.js` | RNF-03, §12 |
| **T-06** | **Tests `drive-scope.service`.** Mock de `google.drive`: `drives.list` con paginación y con error (→ `[]`); `files.list` filtrando carpetas/shortcuts y aplicando `MAX_SHARED_ITEMS`. | `tests/modules/drive/drive-scope.service.test.js` | CA-02/CA-06/CA-09 |
| **T-07** | **Tests `drive-activity.service`.** Extender mocks de `driveactivity.activity.query` para distinguir por scope; cubrir CA-01 (doc de otro/compartido), CA-03/CA-04 (filtro de actor), CA-05 (dedupe e idempotencia), CA-06 (scope que falla), CA-07 (retorno sin cambios), CA-08 (sin compartidos = comportamiento actual). | `tests/modules/drive/drive-activity.service.test.js` | CA-01,03,04,05,06,07,08 |
| **T-08** | **Verificación de no-regresión + perf.** Confirmar que sin unidades/compartidos el resultado iguala al actual; revisar la concurrencia anidada (`SCOPE_CONCURRENCY` × queries por scope) y ajustar defaults si aparece `userRateLimitExceeded`. | (varios) | RNF-02/RNF-06, E-05 |

**Orden / dependencias:** T-01 → T-02 → T-03 → T-04 (T-05 transversal). Tests (T-06, T-07) a medida que avanza cada pieza. T-08 al cierre.

## 6. Puntos de atención técnicos

1. **Concurrencia anidada (rate limits).** Hoy cada scope dispara `1 + 7` queries en paralelo (`Promise.all` interno de `getDriveActivitiesForDay`). Con `SCOPE_CONCURRENCY=5` ⇒ hasta ~40 queries de Activity simultáneas, **más** las páginas. Empezar conservador y medir. Si el batch ya corre con `SCHEDULER_CONCURRENCY` usuarios en paralelo, la multiplicación es mayor aún (ver SPEC batch §6 pto 7).
2. **Dedupe global obligatorio (T-03).** El dedupe actual es **dentro** de un scope (main vs per-action). Al unir scopes, un mismo `fileId+actionType+timestamp` puede repetirse (p. ej. archivo en una unidad compartida que también aparece en "Compartido conmigo"). Sin dedupe global, `byFile` acumularía intervalos duplicados e **inflaría la duración**. Deduplicar por una clave que incluya el instante del evento.
3. **`files.list` y `sharedWithMe`.** `q:"sharedWithMe = true"` trae archivos cuyo dueño es otro y fueron compartidos directamente con el usuario; no incluye los de unidades compartidas (esos se cubren por `ancestorName`). Pasar `supportsAllDrives:true` e `includeItemsFromAllDrives:true`. Excluir `trashed = true` y los `EXCLUDED_MIME_TYPES` para no gastar queries de actividad en carpetas/atajos.
4. **Filtro de actor y privacidad.** `isCurrentUser` es la fuente de verdad. No intentar filtrar por actor en el `filter` de la query (la gramática de la Activity API no lo soporta de forma fiable); filtrar **client-side** sobre `activity.actors`. Una actividad sin `knownUser` resoluble (anónimo/sistema) se descarta (V-02).
5. **Cambio de comportamiento en "Mi unidad" (RN-D03).** Aplicar el filtro de actor también a `items/root` deja de contar ediciones de colaboradores sobre documentos propios. Es lo correcto, pero **cambia números existentes**: dejar el filtro detrás de la decisión §14.4 de la SPEC (confirmar con cliente) — implementarlo como un flag interno fácil de togglear si hace falta acordarlo.
6. **Tope `MAX_SHARED_ITEMS`.** Empleados con cientos/miles de archivos "Compartido conmigo" dispararían una query de actividad por archivo. El tope corta la cola; documentarlo como limitación conocida (E-04).
7. **Idempotencia intacta.** No tocar el esquema del `externalId`; los nuevos `fileId` conviven con los de "Mi unidad" sin colisión. Re-sync sigue actualizando, no duplicando.

## 7. Testing (CA → test)

| Criterio | Test |
|---|---|
| CA-01 | Scope "Compartido conmigo" con actividad del usuario sobre doc de otro → se persiste. |
| CA-02 | `listSharedDriveScopes` devuelve unidad; su actividad propia se persiste. |
| CA-03 | Doc compartido con actividad **solo** de otro actor → no se persiste para el empleado. |
| CA-04 | Actividad con `isCurrentUser !== true` (otro usuario / sistema / anónimo) → descartada. |
| CA-05 | Mismo `fileId+actionType+timestamp` en dos scopes → un solo registro; re-sync no duplica ni infla duración. |
| CA-06 | `drives.list` o un scope de actividad lanza error → demás scopes se persisten; se loguea. |
| CA-07 | Caller con misma firma → retorno `{created, updated, message}` sin cambios. |
| CA-08 | Sin unidades ni compartidos → resultado idéntico al de solo "Mi unidad". |
| CA-09 | Carpetas/shortcuts entre los "Compartido conmigo" → excluidos. |

Tests util extra: `buildDriveScopes` arma el orden esperado; tolerancia a `[]` cuando una enumeración falla.

## 8. Definition of Done

- [ ] T-01…T-08 completas.
- [ ] Todos los CA cubiertos con tests; coverage ≥ 80% (umbral del repo).
- [ ] `npm run lint` y `npm test` en verde.
- [ ] Contrato de `persistDriveActivities` sin cambios (CA-07).
- [ ] Sin nuevos scopes ni migración.
- [ ] Prueba manual: empleado con un doc creado por otro y compartido, editado en la ventana → aparece en `daily_activities`; una edición de un tercero sobre ese doc **no** aparece.
- [ ] Decisión §14.4 de la SPEC (filtro de actor en "Mi unidad") confirmada antes de mergear.

## 9. Fuera de alcance (recordatorio)

Resumen/enriquecimiento de Drive, cambios al modelo de duración o al esquema, Calendar/Jira, actividad de períodos sin acceso, configuración por usuario de la cobertura. (Ver SPEC §13.)

---

## Fuentes (doc oficial de Google)

- [Drive Activity API v2 — `activity.query`](https://developers.google.com/drive/activity/v2/reference/rest/v2/activity/query)
- [Make requests in the Drive Activity API (`itemName`/`ancestorName`, default `items/root`)](https://developers.google.com/workspace/drive/activity/v2/requests)
- [Drive Activity API v2 — `Actor`/`KnownUser` (`isCurrentUser`)](https://developers.google.com/drive/activity/v2/reference/rest/v2/activity/actor)
- [Drive API v3 — `files.list` (`sharedWithMe`, `corpora`, `supportsAllDrives`)](https://developers.google.com/drive/api/v3/reference/files/list)
- [Drive API v3 — `drives.list`](https://developers.google.com/drive/api/v3/reference/drives/list)
