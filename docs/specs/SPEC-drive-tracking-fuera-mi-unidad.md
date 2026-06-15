# SPEC — Tracking de actividad de Drive fuera de "Mi unidad"

> Especificación funcional (estilo SDD — *Spec-Driven Development*). Describe **qué** debe hacer la recolección de actividad de Drive y **por qué**, no el cómo. El detalle técnico (queries concretas, concurrencia, enumeración de archivos) irá en el PLAN derivado de esta spec.

| | |
|---|---|
| **Feature ID** | F-DRIVE-02 (fix de la recolección de actividad de Drive del MVP) |
| **Estado** | Borrador para implementación |
| **Fecha** | 2026-06-15 |
| **Rama** | `fix/drive-tracking-outside-my-unit` |
| **Módulo destino** | `src/modules/drive/` |
| **SPEC relacionada** | [SPEC — Batch Diario de Sincronización](./SPEC-batch-diario-sincronizacion.md) (consume `persistDriveActivities`) |

---

## 1. Propósito

Hoy la recolección de actividad de Google Drive **solo captura documentos de "Mi unidad"** del empleado. Cuando un documento **fue creado por otra persona** o **vive fuera de "Mi unidad"** (Unidades compartidas / "Compartido conmigo"), la actividad del empleado sobre ese documento **no se trackea**, aunque haya trabajado en él durante su jornada.

Esta spec define que la recolección de actividad de Drive debe cubrir **todo el trabajo real del empleado sobre documentos a los que tiene acceso**, sin importar quién es el dueño del archivo ni en qué ubicación de Drive está, atribuyéndole **solo las acciones que el propio empleado realizó**.

## 2. Objetivos y No-objetivos

**Objetivos**
- Capturar la actividad del empleado sobre documentos en **las tres ubicaciones**: "Mi unidad", **Unidades compartidas** (*shared drives*) y **"Compartido conmigo"** (archivos cuyo dueño es otra persona).
- Atribuir al empleado **únicamente las acciones realizadas por él mismo**, descartando las de otros colaboradores sobre los mismos documentos compartidos.
- Mantener la **idempotencia** existente: re-sincronizar la misma ventana no duplica ni infla actividades.
- Ser resiliente: si una de las ubicaciones falla o no devuelve resultados, las demás se persisten igual.
- No requerir nuevos permisos (*scopes*) de Google: la solución usa los ya otorgados.

**No-objetivos** (fuera de alcance de esta spec)
- Cambiar el modelo de estimación de duración (`buildWorkEstimates`, sesiones, buffers) — se reutiliza tal cual.
- Cambiar el esquema de la BD ni la clave de idempotencia (`userId + source + externalId`).
- Capturar actividad de documentos a los que el empleado **no tiene acceso** (imposible por diseño de la API y correcto por privacidad).
- Resumen/enriquecimiento (`summarizeDriveActivities`, `enrichDriveActivitySummary`) — siguen su propio incremento.
- Recolección de Calendar y Jira (otras fuentes, fuera de alcance).

## 3. Actores

| Actor | Descripción |
|---|---|
| **Empleado** | Usuario con Google conectado cuya actividad de Drive se recolecta. Es el "usuario actual" frente a la Drive Activity API. |
| **Caller de la recolección** | Quien invoca `persistDriveActivities(userId, refreshToken, inicio, fin)`: hoy el endpoint de prueba, en producción el **batch diario** ([SPEC batch](./SPEC-batch-diario-sincronizacion.md)). Agnóstico para esta spec. |
| **Google Drive / Drive Activity API** | Fuente de datos externa. Devuelve actividad **respetando los permisos del empleado**. |

## 4. Supuestos y dependencias

### 4.1 Comportamiento de la Drive Activity API (verificado en doc oficial)

- La Drive Activity API (`driveactivity.activity.query`) requiere **`itemName`** (un ítem puntual, `items/{id}`) **o** **`ancestorName`** (una carpeta/raíz y todo su subárbol, `items/{id}`). Son **mutuamente excluyentes**.
- **Si no se especifica ninguno, el default es `ancestorName = items/root`**, que corresponde **solo a "Mi unidad"**. **Esta es la causa raíz del bug:** el código actual no pasa `ancestorName`, por lo que implícitamente consulta solo "Mi unidad".
- **`items/root` NO incluye** Unidades compartidas ni "Compartido conmigo": esos ítems **no cuelgan** de la raíz de "Mi unidad" del usuario.
- Para cubrir las otras ubicaciones:
  - **Unidades compartidas:** cada unidad compartida es su propio árbol. Se consulta con `ancestorName = items/{sharedDriveId}` **por cada unidad** de la que el empleado es miembro. La lista de unidades se obtiene de la **Drive API v3** (`drives.list`).
  - **"Compartido conmigo" (dueño = otra persona, fuera de unidades):** no existe un ancestro común accesible para el usuario, por lo que **se consulta por ítem** con `itemName = items/{fileId}`. La lista de archivos se obtiene de la **Drive API v3** (`files.list` con `q = "sharedWithMe = true"`, `supportsAllDrives = true`).
- **Atribución del actor:** cada actividad expone su autor en `actor.user.knownUser.isCurrentUser` (booleano: `true` si el actor es el usuario autenticado). Es el mecanismo para quedarse solo con las acciones del empleado y descartar las de otros colaboradores.
- **Privacidad por permisos (límite de la API, no un bug):** el empleado solo ve actividad de períodos en los que tuvo acceso al documento. Si perdió el acceso, no verá la actividad posterior. Aceptado.

### 4.2 Dependencias del sistema

- **Scopes de Google ya otorgados** (no se agregan nuevos): `drive.activity.readonly` (consulta de actividad), `drive.metadata.readonly` y `drive` (enumeración de unidades y archivos vía Drive API v3). Verificado en `auth.service.js`.
- **`persistDriveActivities(userId, refreshToken, inicio, fin)`** es el punto de entrada existente que esta spec modifica. Su **contrato externo no cambia** (mismos parámetros y forma de retorno `{created, updated, message}`).
- **Clave de idempotencia intacta:** el `externalId` ya se construye sobre `fileId` (`file_{fileId}_{actionType}_{windowDate}[_sN]`). Sumar nuevas ubicaciones solo aporta nuevos `fileId`; no colisiona con los de "Mi unidad". No hace falta migración.

## 5. Casos de Uso

### CU-01 — Recolección de actividad de Drive de un empleado (con cobertura completa)
- **Actor:** Caller de la recolección (batch o endpoint).
- **Precondición:** empleado con Google conectado; ventana `[inicio, fin)` válida (UTC).
- **Disparador:** llamada a `persistDriveActivities(userId, refreshToken, inicio, fin)`.
- **Flujo principal:**
  1. Validar la ventana (igual que hoy: ISO válido, `inicio < fin`, ≤ tope de ventana).
  2. **Determinar el alcance de consulta**, combinando:
     - **a.** "Mi unidad" → `ancestorName = items/root` (comportamiento actual, ahora explícito).
     - **b.** Cada **unidad compartida** del empleado (`drives.list`) → `ancestorName = items/{sharedDriveId}`.
     - **c.** Cada **archivo "Compartido conmigo"** relevante (`files.list`, `sharedWithMe = true`) → `itemName = items/{fileId}`.
  3. Consultar la Drive Activity API para cada alcance, dentro de la misma ventana de tiempo y con la misma estrategia de consolidación/acciones que hoy.
  4. **Unir y deduplicar** todas las actividades crudas (por `fileId + actionType`, como hoy).
  5. **Filtrar a las acciones del propio empleado:** descartar toda actividad cuyo actor no sea el usuario actual (`actor.user.knownUser.isCurrentUser !== true`).
  6. Agrupar por archivo+acción, estimar duración (`buildWorkEstimates`, sin cambios) y **upsert** idempotente en `daily_activities`.
  7. Devolver `{created, updated, message}`.
- **Postcondición:** la actividad del empleado en las tres ubicaciones queda persistida y atribuida solo a él, sin duplicados.
- **Flujos alternativos / excepciones (aisladas, no abortan la recolección):**
  - 2b-i. *El empleado no es miembro de ninguna unidad compartida* → se omite (b); continúa con (a) y (c).
  - 2c-i. *No hay archivos "Compartido conmigo"* → se omite (c); continúa con (a) y (b).
  - 3a. *Falla la consulta de un alcance puntual* (un shared drive, un ítem, o la enumeración) → se loguea, se omite **ese** alcance y se continúa con el resto (recolección parcial mejor que nada).
  - 5a. *Un documento solo tiene acciones de otros* → tras el filtro de actor queda sin registros; no se persiste para ese archivo (correcto).

## 6. Reglas de Negocio

| ID | Regla |
|---|---|
| **RN-D01** | La recolección de Drive cubre **las tres ubicaciones**: "Mi unidad", Unidades compartidas y "Compartido conmigo". No se limita a `items/root`. |
| **RN-D02** | Solo se atribuye al empleado la actividad cuyo actor es **él mismo** (`actor.user.knownUser.isCurrentUser === true`). Las acciones de otros colaboradores sobre documentos compartidos **no** se cuentan como trabajo del empleado. |
| **RN-D03** | *Aplica también a "Mi unidad":* el filtro de actor (RN-D02) corrige el sobreconteo latente actual, donde un colaborador editando un documento de mi unidad se contaba como actividad mía. (Cambio de comportamiento — ver §14.) |
| **RN-D04** | *Idempotencia preservada:* la clave `userId + source + externalId` (con `externalId` basado en `fileId`) no cambia; re-sincronizar actualiza, no duplica. Las nuevas ubicaciones solo aportan nuevos `fileId`. |
| **RN-D05** | *Cobertura parcial tolerada:* el fallo al consultar una ubicación o un ítem puntual no aborta el resto; se persiste lo que sí se obtuvo y se loguea lo que falló. |
| **RN-D06** | *Exclusiones vigentes:* carpetas, accesos directos y MIME types ya excluidos (`EXCLUDED_MIME_TYPES`) se siguen excluyendo en todas las ubicaciones. |
| **RN-D07** | *Sin nuevos permisos:* la solución opera con los scopes ya otorgados. Si un scope necesario faltara para un usuario, esa parte se omite y se loguea (no rompe la recolección). |
| **RN-D08** | *Solo actividad accesible:* no se intenta recuperar actividad de períodos sin acceso del empleado (límite de la API, aceptado). |

## 7. Validaciones

| ID | Validación | Cuándo | Si falla |
|---|---|---|---|
| **V-01** | Ventana `[inicio, fin)`: ISO 8601 válido, `inicio < fin`, ≤ tope (`MAX_WINDOW_MS`). | Al inicio de `persistDriveActivities` (ya existe). | `InvalidWindowError` (400). Sin cambios. |
| **V-02** | El actor de cada actividad es resoluble como "usuario actual". | Al filtrar por actor (CU-01 paso 5). | Si no se puede determinar el actor (actor anónimo / sistema / sin `knownUser`), se descarta esa actividad (no se atribuye al empleado). |
| **V-03** | La enumeración de unidades compartidas / archivos "Compartido conmigo" responde correctamente. | Al armar el alcance (CU-01 paso 2). | Se omite esa fuente de enumeración, se loguea y se continúa con las demás ubicaciones (RN-D05). |
| **V-04** | El `fileId` de un ítem "Compartido conmigo" es consultable por `itemName`. | Por cada ítem (CU-01 paso 3c). | Se omite ese ítem, se loguea y se continúa. |

## 8. Casos borde

| ID | Caso | Comportamiento esperado |
|---|---|---|
| **E-01** | Documento creado por otra persona y compartido con el empleado; el empleado lo editó en su jornada. | Se captura su edición (vía "Compartido conmigo" / unidad compartida) y se atribuye al empleado (RN-D01/D02). **Caso central del bug.** |
| **E-02** | Documento compartido donde **otro** colaboró pero el empleado **no** tocó. | No genera actividad del empleado (filtro de actor, RN-D02). |
| **E-03** | Mismo documento aparece en más de un alcance (p. ej. enumerado en "Compartido conmigo" y también bajo una unidad compartida). | La deduplicación por `fileId + actionType` evita registros repetidos (RN-D04). |
| **E-04** | Empleado con **muchos** archivos "Compartido conmigo". | La consulta por ítem se acota en concurrencia/volumen para no gatillar rate limits; documentar tope si aplica (ver RNF-02, §14). |
| **E-05** | Empleado sin unidades compartidas y sin archivos compartidos. | Equivale al comportamiento actual: solo "Mi unidad". Sin errores. |
| **E-06** | El empleado perdió acceso a un documento donde antes trabajó. | Se captura la actividad del período con acceso; nada del período sin acceso (RN-D08). |
| **E-07** | Falla la Drive Activity API para una unidad compartida puntual (5xx / permiso). | Se omite esa unidad, se loguea, las demás ubicaciones se persisten (RN-D05). |
| **E-08** | Re-sync de la misma ventana tras ampliar el alcance. | Idempotente: actualiza duraciones, no duplica (RN-D04). |
| **E-09** | Actividad cuyo actor es un proceso/sistema o un usuario anónimo. | Se descarta: no es trabajo atribuible al empleado (V-02). |

## 9. Requisitos No Funcionales

| ID | Requisito |
|---|---|
| **RNF-01** | *Compatibilidad:* el contrato de `persistDriveActivities` (firma y retorno) no cambia; el batch y el endpoint actuales siguen funcionando sin tocarlos. |
| **RNF-02** | *Rate limits:* ampliar el alcance multiplica las llamadas a Google (enumeración + 1 query de actividad por unidad y por ítem compartido). Acotar la concurrencia (patrón `mapWithConcurrency` ya existente) y documentar el costo; convivir con la concurrencia anidada del batch. |
| **RNF-03** | *Observabilidad:* logs estructurados (Winston) por ubicación: cuántas unidades/ítems se enumeraron, cuántas actividades crudas trajo cada alcance, cuántas se descartaron por actor, y cualquier alcance omitido por error. Sin PII (solo `userId`, `fileId`). |
| **RNF-04** | *Resiliencia:* ningún fallo de un alcance individual aborta la recolección completa (RN-D05). |
| **RNF-05** | *Seguridad/privacidad:* sin nuevos scopes; nunca se persiste actividad de otros colaboradores como propia; respeto estricto de los permisos del empleado. |
| **RNF-06** | *Performance aceptable:* la recolección de una jornada (~1 día) debe completar dentro de los tiempos del batch aun con decenas de unidades/ítems compartidos. |

## 10. Modelo de datos y configuración

- **Sin cambios de esquema:** se sigue escribiendo en `daily_activities` (`DailyActivity`) con la misma clave de idempotencia. El `externalId` basado en `fileId` absorbe los nuevos archivos sin colisión. No hay migración.
- **Sin nuevas variables de entorno obligatorias.** Opcional: un tope de concurrencia/volumen para la enumeración y consulta por ítem de "Compartido conmigo" (p. ej. reutilizar/duplicar el patrón de `ENRICH_CONCURRENCY`), configurable si se decide exponerlo.
- **Scopes:** ya presentes (`drive.activity.readonly`, `drive.metadata.readonly`, `drive`). No se solicitan nuevos.

## 11. Criterios de Aceptación

> Formato Dado / Cuando / Entonces. Verificables con tests (Jest), mockeando la Drive Activity API y la Drive API v3.

- **CA-01 (RN-D01, E-01):** *Dado* un empleado que editó, durante la ventana, un documento **creado por otra persona y compartido con él**, *cuando* corre `persistDriveActivities`, *entonces* esa actividad se persiste en `daily_activities`.
- **CA-02 (RN-D01):** *Dado* un empleado miembro de una **unidad compartida** con actividad propia en un archivo de esa unidad, *cuando* corre la recolección, *entonces* esa actividad se persiste (no solo la de "Mi unidad").
- **CA-03 (RN-D02, E-02):** *Dado* un documento compartido donde **otro colaborador** editó pero el empleado **no**, *cuando* corre la recolección, *entonces* **no** se crea actividad para el empleado.
- **CA-04 (RN-D02/D03, E-09):** *Dada* una actividad cuyo actor no es el usuario actual (`isCurrentUser !== true`, otro usuario o sistema), *cuando* corre la recolección, *entonces* se descarta y no se atribuye al empleado.
- **CA-05 (RN-D04, E-03/E-08):** *Dado* un mismo documento que aparece en más de un alcance, o un re-sync de la misma ventana, *cuando* corre la recolección, *entonces* no se generan registros duplicados (idempotencia por `externalId`).
- **CA-06 (RN-D05, E-07):** *Dado* que la consulta de **una** unidad compartida (o un ítem) falla, *cuando* corre la recolección, *entonces* las demás ubicaciones se persisten igual y el fallo queda logueado.
- **CA-07 (RNF-01):** *Dado* el caller actual (endpoint/batch) sin cambios, *cuando* invoca `persistDriveActivities` con los mismos parámetros, *entonces* recibe la misma forma de retorno `{created, updated, message}`.
- **CA-08 (E-05):** *Dado* un empleado sin unidades compartidas ni archivos compartidos, *cuando* corre la recolección, *entonces* el resultado equivale al de "Mi unidad" actual, sin errores.
- **CA-09 (RN-D06):** *Dado* que entre los ítems compartidos hay carpetas o accesos directos, *cuando* corre la recolección, *entonces* se excluyen igual que en "Mi unidad".

## 12. Observabilidad

Eventos de log mínimos (Winston, estructurado; solo `userId`/`fileId`, sin PII):
- `drive.scope.enumerated` — `userId`, cantidad de unidades compartidas y de archivos "Compartido conmigo" detectados.
- `drive.scope.queried` — por ubicación: actividades crudas obtenidas.
- `drive.actor.filtered` — cantidad de actividades descartadas por no ser del usuario actual.
- `drive.scope.skipped` — ubicación/ítem omitido y motivo (error de enumeración / consulta / permiso / scope faltante).
- `drive.persist.done` — `created`, `updated`.

## 13. Fuera de alcance

- Resumen/enriquecimiento de Drive (`summarizeDriveActivities`, `enrichDriveActivitySummary`).
- Cambios al modelo de estimación de duración o al esquema de `daily_activities`.
- Recolección de Calendar y Jira.
- Captura de actividad de períodos sin acceso del empleado (límite de la API).
- Exponer la cobertura ampliada como configuración por usuario (siempre activa).

## 14. Cuestiones

**Resueltas**
1. **Causa raíz:** el default `ancestorName = items/root` limita la consulta a "Mi unidad"; las otras ubicaciones requieren `ancestorName` por unidad compartida e `itemName` por archivo "Compartido conmigo" (doc oficial verificada).
2. **Atribución:** se filtra por `actor.user.knownUser.isCurrentUser` para contar solo el trabajo del empleado.
3. **Sin nuevos scopes ni migración:** se reutilizan los permisos y la clave de idempotencia actuales.

**A confirmar (con cliente/equipo)**
4. **Cambio de comportamiento en "Mi unidad" (RN-D03):** aplicar el filtro de actor también a "Mi unidad" deja de contar las acciones de colaboradores sobre documentos propios. Es el comportamiento correcto para "trabajo del empleado", pero **cambia los números actuales**. Confirmar antes de mergear.
5. **Tope de "Compartido conmigo" (E-04, RNF-02):** definir si se limita el volumen/concurrencia de la consulta por ítem y con qué valor por defecto, para acotar el costo en empleados con muchos archivos compartidos.

---

## Fuentes (doc oficial de Google consultada)

- [Drive Activity API v2 — `activity.query` (referencia REST)](https://developers.google.com/drive/activity/v2/reference/rest/v2/activity/query)
- [Make requests in the Google Drive Activity API (`itemName` vs `ancestorName`, default `items/root`)](https://developers.google.com/workspace/drive/activity/v2/requests)
- [Drive Activity API v2 — `Actor` / `KnownUser` (`isCurrentUser`)](https://developers.google.com/drive/activity/v2/reference/rest/v2/activity/actor)
