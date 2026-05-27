# Drive Activity API v2 — Referencia técnica para el proyecto

## ¿Qué es?

La Drive Activity API v2 es una API separada de la Drive API, con su propia URL base. Permite consultar el historial de actividades sobre archivos y carpetas de Google Drive: quién hizo qué, sobre qué archivo, y cuándo.

A diferencia de la Drive API (que consulta metadatos y contenido), esta API consulta **eventos de actividad** — ediciones, creaciones, movimientos, comentarios, cambios de permisos, etc.

---

## Endpoint

```
POST https://driveactivity.googleapis.com/v2/activity:query
```

Es un único endpoint con método POST. Los parámetros van en el body JSON, no en la query string.

---

## Scope OAuth requerido

```
https://www.googleapis.com/auth/drive.activity.readonly
```

Este scope es **adicional** a los que ya maneja el proyecto. Hay que sumarlo al array de scopes en `src/modules/auth/auth.service.js` junto con los de Drive, Calendar, etc.

---

## Estructura de la respuesta

Cada elemento de `activities[]` es un objeto `DriveActivity`:

```
DriveActivity
├── primaryActionDetail   ← tipo principal de la actividad
├── actions[]             ← array de todas las acciones agrupadas
│   └── Action
│       ├── detail        ← tipo específico (ver sección de tipos)
│       ├── actor         ← quién realizó la acción
│       ├── target        ← sobre qué archivo o carpeta
│       └── timestamp     ← cuándo (instante puntual)  ← uno u otro
│           timeRange     ← cuándo (rango con inicio y fin)
├── actors[]              ← todos los actores del grupo
└── targets[]             ← todos los archivos afectados
```

### Tipos de acción disponibles

| Tipo | Descripción |
|---|---|
| `create` | Se creó un archivo o carpeta |
| `edit` | Se editó el contenido |
| `move` | Se movió a otra carpeta |
| `rename` | Se le cambió el nombre |
| `delete` | Se eliminó |
| `restore` | Se restauró desde la papelera |
| `permissionChange` | Se modificaron los permisos de acceso |
| `comment` | Se agregó o modificó un comentario |
| `dlpChange` | Cambió el estado de prevención de pérdida de datos |
| `reference` | Se referenció desde una app externa |
| `settingsChange` | Se modificó una configuración |
| `appliedLabelChange` | Se cambió una etiqueta |

### Tipos de actor

| Tipo | Descripción |
|---|---|
| `user` | Usuario final (incluye nombre y email en `knownUser`) |
| `anonymous` | Usuario no autenticado |
| `impersonation` | Cuenta actuando en nombre de otra |
| `system` | Acción disparada por el sistema (no por un usuario) |
| `administrator` | Administrador del workspace |

---

## Limitación importante: no existe campo `duration`

Esta es la limitación más relevante para el proyecto. El tiempo de una actividad se representa de **dos formas distintas** y ninguna expone una duración directa:

### `timestamp` — evento puntual

```json
{
  "timestamp": "2025-03-15T10:32:00.000Z"
}
```

Indica el momento exacto en que ocurrió la acción. No hay duración: el evento es instantáneo desde el punto de vista de la API.

### `timeRange` — rango de tiempo

```json
{
  "timeRange": {
    "startTime": "2025-03-15T10:00:00.000Z",
    "endTime":   "2025-03-15T10:47:23.000Z"
  }
}
```

Indica que la actividad ocurrió durante un período. La API agrupa ediciones continuas bajo un mismo `timeRange`.

### Cómo calcular duración

```js
function getDurationMs(activity) {
  const action = activity.actions?.[0];
  if (!action) return null;

  if (action.timeRange) {
    const start = new Date(action.timeRange.startTime).getTime();
    const end   = new Date(action.timeRange.endTime).getTime();
    return end - start;
  }

  // timestamp puntual: duración no determinable
  return null;
}
```

### Implicancias para el módulo de actividades

- Las actividades sincronizadas desde Drive pueden llegar **sin duración**.
- El campo `duration` en la BD debe admitir `null` para actividades de Drive.
- En la UI, mostrar "duración desconocida" o simplemente omitir el campo cuando sea `null`.
- Un `edit` típicamente viene con `timeRange`, pero no está garantizado por la API.

---

## Cómo filtrar actividades

Los parámetros del body de la request permiten filtrar qué actividades devuelve la API.

### Por archivo específico o carpeta

`itemName` y `ancestorName` son **mutuamente excluyentes**: usar uno o el otro.

```json
// Solo este archivo
{
  "itemName": "items/FILE_ID"
}

// Esta carpeta y todo su contenido (incluye subdirectorios)
{
  "ancestorName": "items/FOLDER_ID"
}
```

Si no se especifica ninguno, el default es `"items/root"` (toda la unidad del usuario).

### Por tiempo y tipo de acción

```json
{
  "itemName": "items/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
  "filter": "time >= \"2025-01-01T00:00:00Z\" AND detail.action_detail_case:(EDIT CREATE)"
}
```

**Operadores de tiempo:** `>`, `>=`, `<`, `<=`. Acepta formato RFC 3339 o milisegundos desde epoch.

**Filtro de tipo de acción:**
```
detail.action_detail_case:(CREATE EDIT RENAME)   ← OR entre tipos
detail.action_detail_case:MOVE                   ← tipo único
-detail.action_detail_case:EDIT                  ← excluir un tipo
```

### Paginación

```json
{
  "pageSize": 50,
  "pageToken": "<token_de_la_respuesta_anterior>"
}
```

`pageSize` es aproximado — la API puede devolver más o menos items. Si hay más páginas, la respuesta incluye `nextPageToken`.

---

## Ejemplo completo en Node.js

```js
const { google } = require('googleapis');

async function getFileActivity(authClient, fileId, since) {
  const driveActivity = google.driveactivity({ version: 'v2', auth: authClient });

  const { data } = await driveActivity.activity.query({
    requestBody: {
      itemName: `items/${fileId}`,
      filter: `time >= "${since.toISOString()}" AND detail.action_detail_case:(EDIT CREATE)`,
      pageSize: 100,
      consolidationStrategy: { legacy: {} },
    },
  });

  return (data.activities || []).map(activity => {
    const action   = activity.actions?.[0];
    const actor    = activity.actors?.[0]?.user?.knownUser;
    const target   = activity.targets?.[0]?.driveItem;

    const startTime = action?.timeRange?.startTime ?? action?.timestamp;
    const endTime   = action?.timeRange?.endTime   ?? action?.timestamp;
    const durationMs = action?.timeRange
      ? new Date(endTime).getTime() - new Date(startTime).getTime()
      : null;

    return {
      type:       activity.primaryActionDetail ? Object.keys(activity.primaryActionDetail)[0] : 'unknown',
      actorEmail: actor?.personName ?? null,
      fileId:     target?.name?.replace('items/', '') ?? null,
      fileName:   target?.title ?? null,
      startTime,
      endTime,
      durationMs,  // null si fue timestamp puntual
    };
  });
}
```

---

## Quotas

| Límite | Valor |
|---|---|
| Requests por día por proyecto | ~100.000 (configurable en Google Cloud Console) |
| Unidades por minuto por proyecto | 1.000.000 |
| Unidades por minuto por usuario por proyecto | 325.000 |

Los límites exactos de la Drive Activity API comparten el pool de cuota de la Drive API en Google Cloud Console. El valor de 100k/día es el default para proyectos nuevos y puede solicitarse aumento desde la consola.

**Consecuencias para el diseño:**
- No conviene llamar a la Activity API en tiempo real por cada acción del usuario.
- El patrón correcto es un **job de sincronización periódico** (cron o trigger manual) que consulte la actividad desde el último timestamp registrado.
- Usar `filter` con `time >=` para no re-procesar actividad ya sincronizada.

---

## Diferencias clave respecto a la Drive API

| | Drive API (`files.get`) | Drive Activity API |
|---|---|---|
| URL base | `www.googleapis.com/drive/v3` | `driveactivity.googleapis.com/v2` |
| Método HTTP | GET | POST |
| Qué devuelve | Metadatos del archivo | Historial de eventos |
| Tiene duración | No aplica | No (hay que calcularla) |
| Scope | `drive.metadata.readonly` | `drive.activity.readonly` |

---

## Referencia oficial

- Introducción: https://developers.google.com/workspace/drive/activity/v2
- Modelo de datos: https://developers.google.com/workspace/drive/activity/v2/datamodel
- Referencia REST: https://developers.google.com/drive/activity/v2/reference/rest
- Guía de requests: https://developers.google.com/workspace/drive/activity/v2/requests
- Límites de uso: https://developers.google.com/workspace/drive/api/guides/limits
