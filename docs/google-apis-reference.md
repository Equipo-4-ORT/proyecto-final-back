# Referencia de Google APIs — AutoLog

Documento unificado de las APIs de Google utilizadas en el proyecto para sincronizar actividades de los usuarios. Cubre la **Google Calendar API v3** y la **Google Drive Activity API v2**.

---

## Índice

1. [Calendar API v3](#1-calendar-api-v3)
2. [Drive Activity API v2](#2-drive-activity-api-v2)
3. [Comparativa de quotas](#3-comparativa-de-quotas)
4. [Patrones comunes](#4-patrones-comunes)

---

## 1. Calendar API v3

### Endpoint principal

```
GET https://www.googleapis.com/calendar/v3/calendars/primary/events
```

Implementado en el proyecto con la librería `googleapis`:

```js
const calendar = google.calendar({ version: 'v3', auth });
await calendar.events.list({ calendarId: 'primary', ...params });
```

### Parámetros de filtrado

| Parámetro | Tipo | Descripción |
|---|---|---|
| `timeMin` | string (RFC 3339) | Límite inferior del rango. Ej: `2026-05-25T00:00:00Z` |
| `timeMax` | string (RFC 3339) | Límite superior del rango. Ej: `2026-05-26T00:00:00Z` |
| `singleEvents` | boolean | Debe ser `true` para expandir eventos recurrentes en instancias individuales |
| `orderBy` | string | `'startTime'` para orden cronológico |

### Estructura de respuesta relevante

La respuesta contiene un array `items`. Los campos útiles por evento:

| Campo | Descripción |
|---|---|
| `id` | Identificador único del evento (usado como `externalId`) |
| `summary` | Título del evento |
| `start.dateTime` | Inicio con hora exacta (ISO 8601 con timezone) |
| `end.dateTime` | Fin con hora exacta |
| `start.date` | Solo fecha (eventos de todo el día — se descartan) |
| `attendees[]` | Lista de participantes con `email`, `self`, `responseStatus` |
| `organizer.email` | Email del organizador |
| `hangoutLink` | Link de Google Meet (si es una reunión) |
| `conferenceData.conferenceSolution.key.type` | `'hangoutsMeet'` si es Google Meet |

### Lógica de filtrado aplicada en el proyecto

Antes de persistir, se descartan eventos que:
- No tienen `start.dateTime` (eventos de todo el día)
- No tienen asistentes (`attendees` vacío)
- El usuario rechazó la invitación (`responseStatus === 'declined'`)

La detección de Google Meet se hace con:
```js
const isMeet = event.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet';
// activityType: isMeet ? 'meeting' : 'event'
```

### Quota

| Límite | Valor |
|---|---|
| Requests por día por proyecto | **1.000.000** |

---

## 2. Drive Activity API v2

### Endpoint principal

```
POST https://driveactivity.googleapis.com/v2/activity:query
```

A diferencia de Calendar, este endpoint usa **POST** con los parámetros en el body JSON.

Implementado en el proyecto:

```js
const driveactivity = google.driveactivity({ version: 'v2', auth });
await driveactivity.activity.query({ requestBody: { ...params } });
```

### Parámetros del body

| Parámetro | Descripción |
|---|---|
| `ancestorName` | `'items/root'` para consultar toda la unidad del usuario |
| `filter` | Expresión de tiempo y/o tipo de acción (ver ejemplos abajo) |
| `consolidationStrategy` | `{ legacy: {} }` para agrupación compatible con v1 |
| `pageSize` | Cantidad de resultados por página (máx ~100) |
| `pageToken` | Token para la siguiente página (ver paginación) |

### Filtro por rango de fecha

```
time >= "2026-05-22T00:00:00Z" AND time < "2026-05-23T00:00:00Z"
```

El formato debe ser **RFC 3339 en UTC**. Si el usuario está en una zona horaria distinta, hay que convertir el inicio y fin del día a UTC antes de armar el filtro.

### Tipos de acción (`primaryActionDetail`)

La API devuelve un campo `primaryActionDetail` con el tipo de actividad. El proyecto utiliza los siguientes:

| Tipo | Descripción | Usado en AutoLog |
|---|---|---|
| `edit` | El usuario modificó el contenido del archivo | ✅ Sí |
| `create` | Se creó o subió un archivo nuevo | ✅ Sí |
| `comment` | Comentarios, sugerencias, resoluciones en hilos | ✅ Sí |
| `rename` | Se le cambió el nombre al archivo | ❌ No |
| `move` | El archivo fue movido de carpeta | ❌ No |
| `delete` | El archivo fue eliminado | ❌ No |
| `restore` | El archivo fue restaurado | ❌ No |
| `permissionChange` | Se modificaron los permisos | ❌ No |

### Estructura de respuesta

```json
{
  "activities": [
    {
      "primaryActionDetail": { "edit": {} },
      "actors": [
        { "user": { "knownUser": { "personName": "people/123456" } } }
      ],
      "targets": [
        {
          "driveItem": {
            "name": "items/doc1",
            "title": "Documento de Arquitectura",
            "mimeType": "application/vnd.google-apps.document"
          }
        }
      ],
      "timestamp": "2026-05-22T14:30:00.000Z"
    }
  ],
  "nextPageToken": "token-para-siguiente-pagina"
}
```

### Limitación importante: no hay campo `duration`

El tiempo de una actividad se representa de dos formas distintas:

| Campo | Cuándo aparece | Qué significa |
|---|---|---|
| `timestamp` | Evento puntual (create, rename, etc.) | Un solo instante |
| `timeRange.startTime` + `timeRange.endTime` | Sesión de trabajo (edit prolongado) | Duración calculable |

**No existe un campo `duration`**. Si la actividad tiene `timeRange`, la duración se calcula como:

```js
const durationMs = new Date(timeRange.endTime) - new Date(timeRange.startTime);
```

Si solo tiene `timestamp`, la duración es desconocida y se guarda como `null` en la BD. En ese caso `startTime === endTime`.

### Paginación

La API puede devolver resultados paginados. Cuando hay más páginas, la respuesta incluye `nextPageToken`. El servicio debe acumular todas las páginas antes de persistir:

```js
let activities = [];
let nextPageToken = null;

do {
    const response = await driveactivity.activity.query({
        requestBody: {
            ancestorName: 'items/root',
            filter: `time >= "${timeMin}" AND time < "${timeMax}"`,
            consolidationStrategy: { legacy: {} },
            pageSize: 100,
            ...(nextPageToken && { pageToken: nextPageToken }),
        },
    });

    activities.push(...(response.data.activities || []));
    nextPageToken = response.data.nextPageToken || null;
} while (nextPageToken);
```

### Quota y manejo de errores

| Límite | Valor |
|---|---|
| Requests por día por proyecto | **100.000** |

Cuando se supera el límite, la API responde con `HTTP 429 Too Many Requests`. Se recomienda implementar **Exponential Backoff** para reintentos:

```js
// Lógica sugerida: esperar 2^intento * 1000ms antes de reintentar
// Intento 1: 1s, Intento 2: 2s, Intento 3: 4s, ...
```

### Scope OAuth requerido

```
https://www.googleapis.com/auth/drive.activity.readonly
```

---

## 3. Comparativa de quotas

| API | Límite diario | Límite por minuto | Notas |
|---|---|---|---|
| Calendar API v3 | 1.000.000 req/día | 1.000 req/100s por usuario | Muy generoso para el alcance del proyecto |
| Drive Activity API v2 | 100.000 req/día | N/D documentado | Más restrictivo — usar sync periódico, no en tiempo real |

**Implicancia de diseño:** dado que Drive Activity tiene un límite 10x más bajo que Calendar, el sync de Drive debe implementarse como un job periódico (ver ADR-004) y nunca dispararse por cada acción del usuario.

---

## 4. Patrones comunes

### Obtener el cliente autenticado

Ambas APIs usan el mismo cliente OAuth2:

```js
const { getAuthenticatedGoogleClient } = require('../google/google.service');

const auth = getAuthenticatedGoogleClient(refreshToken); // refreshToken ya descifrado
const calendar = google.calendar({ version: 'v3', auth });
const driveactivity = google.driveactivity({ version: 'v2', auth });
```

### Construir el rango de un día completo

```js
const startDate = new Date(dateStr);           // '2026-05-22'
const timeMin = startDate.toISOString();       // '2026-05-22T00:00:00.000Z'

const endDate = new Date(startDate);
endDate.setDate(endDate.getDate() + 1);
const timeMax = endDate.toISOString();         // '2026-05-23T00:00:00.000Z'
```

> ⚠️ Este cálculo asume que `dateStr` ya fue ajustado a la timezone del usuario. Si el frontend manda una fecha local, hay que convertir el inicio/fin del día a UTC usando la timezone del usuario antes de armar el filtro. Ver `dayToUTCRange()` en `activities.service.js`.

### Persistencia idempotente

Ambas integraciones usan `skipDuplicates: true` en Prisma para evitar duplicados si el sync se ejecuta más de una vez el mismo día:

```js
await prisma.dailyActivity.createMany({
    data: activitiesToSave,
    skipDuplicates: true,
});
```

El campo `externalId` actúa como clave de deduplicación:
- **Calendar:** usa `event.id` (provisto por Google, estable)
- **Drive:** usa un ID sintético `${actionType}_${fileId}_${timestamp}` (la API no expone un ID estable por actividad)

---

## Referencias oficiales

- [Calendar API v3 — events.list](https://developers.google.com/calendar/api/v3/reference/events/list)
- [Drive Activity API v2 — activity.query](https://developers.google.com/drive/activity/v2/reference/rest/v2/activity/query)
- [Drive Activity API — modelo de datos](https://developers.google.com/workspace/drive/activity/v2/datamodel)
- [Drive Activity API — límites de uso](https://developers.google.com/workspace/drive/api/guides/limits)
- [Exponential Backoff — guía de Google](https://developers.google.com/drive/api/guides/handle-errors#exponential-backoff)
