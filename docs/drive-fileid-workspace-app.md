# Relacionar un `fileId` de Drive con la aplicación de Google Workspace que lo creó

## ¿De qué se trata?

Cada archivo en Google Drive tiene un identificador único llamado `fileId`. Este ID aparece en la URL del archivo:

```
https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
                                    ↑__________________________________________↑
                                                      fileId
```

Para saber qué aplicación de Google Workspace creó ese archivo (Docs, Sheets, Slides, etc.), se consultan sus **metadatos** usando la **Drive API v3**, que expone el endpoint `files.get`. El campo clave en la respuesta es `mimeType`.

---

## El campo `mimeType`

Google asigna un MIME type exclusivo a cada tipo de archivo nativo de Workspace, todos bajo el prefijo `application/vnd.google-apps.*`.

| `mimeType` | Aplicación |
|---|---|
| `application/vnd.google-apps.document` | Google Docs |
| `application/vnd.google-apps.spreadsheet` | Google Sheets |
| `application/vnd.google-apps.presentation` | Google Slides |
| `application/vnd.google-apps.form` | Google Forms |
| `application/vnd.google-apps.drawing` | Google Drawings |
| `application/vnd.google-apps.script` | Apps Script |
| `application/vnd.google-apps.site` | Google Sites |
| `application/vnd.google-apps.jam` | Google Jamboard |
| `application/vnd.google-apps.folder` | Carpeta de Drive |
| `application/vnd.google-apps.shortcut` | Acceso directo de Drive |

Si el archivo no fue creado por una app de Workspace (por ejemplo, un PDF o una imagen subidos desde la computadora), el `mimeType` será uno estándar como `application/pdf` o `image/jpeg`, y no tendrá el prefijo `vnd.google-apps`.

---

## Cómo consultarlo: `files.get`

### Endpoint

```
GET https://www.googleapis.com/drive/v3/files/{fileId}
```

### Parámetro `fields`

Se usa para pedir solo los campos que interesan (reduce el tamaño de la respuesta):

```
fields=id,name,mimeType,createdTime,modifiedTime,webViewLink
```

### Autenticación

Requiere un token de acceso OAuth 2.0 con el scope:

```
https://www.googleapis.com/auth/drive.metadata.readonly
```

---

## Ejemplos

### Ejemplo 1 — Documento de Google Docs

**Request:**
```http
GET https://www.googleapis.com/drive/v3/files/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
     ?fields=id,name,mimeType,createdTime,modifiedTime,webViewLink
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "id": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
  "name": "Informe Q1",
  "mimeType": "application/vnd.google-apps.document",
  "createdTime": "2024-03-01T10:00:00.000Z",
  "modifiedTime": "2024-03-15T18:30:00.000Z",
  "webViewLink": "https://docs.google.com/document/d/1BxiMVs0XRA5.../edit"
}
```

→ `mimeType` = `application/vnd.google-apps.document` → **Google Docs**

---

### Ejemplo 2 — Planilla de Google Sheets

**Request:**
```http
GET https://www.googleapis.com/drive/v3/files/1m5mLpkSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
     ?fields=id,name,mimeType
Authorization: Bearer <access_token>
```

**Response:**
```json
{
  "id": "1m5mLpkSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "name": "Presupuesto 2024",
  "mimeType": "application/vnd.google-apps.spreadsheet"
}
```

→ `mimeType` = `application/vnd.google-apps.spreadsheet` → **Google Sheets**

---

### Ejemplo 3 — Presentación de Google Slides

**Response:**
```json
{
  "id": "1pQrXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "name": "Pitch de producto",
  "mimeType": "application/vnd.google-apps.presentation"
}
```

→ `mimeType` = `application/vnd.google-apps.presentation` → **Google Slides**

---

### Ejemplo 4 — PDF subido a Drive (no es un archivo nativo de Workspace)

**Response:**
```json
{
  "id": "0BxXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "name": "contrato.pdf",
  "mimeType": "application/pdf"
}
```

→ `mimeType` = `application/pdf` → **No es un archivo nativo de Workspace**

---

## Cómo se usa en código (Node.js)

Con la librería oficial `googleapis`:

```js
const { google } = require('googleapis');

async function getWorkspaceApp(authClient, fileId) {
  const drive = google.drive({ version: 'v3', auth: authClient });

  const { data } = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType',
  });

  const MIME_TO_APP = {
    'application/vnd.google-apps.document':     'Google Docs',
    'application/vnd.google-apps.spreadsheet':  'Google Sheets',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form':         'Google Forms',
    'application/vnd.google-apps.drawing':      'Google Drawings',
    'application/vnd.google-apps.script':       'Apps Script',
  };

  return {
    id:           data.id,
    name:         data.name,
    mimeType:     data.mimeType,
    workspaceApp: MIME_TO_APP[data.mimeType] ?? null,
  };
}
```

**Resultado para un archivo de Sheets:**
```json
{
  "id": "1m5mLpk...",
  "name": "Presupuesto 2024",
  "mimeType": "application/vnd.google-apps.spreadsheet",
  "workspaceApp": "Google Sheets"
}
```

---

## Resumen

1. Cada archivo en Drive tiene un `fileId` visible en su URL.
2. Se llama a `GET /drive/v3/files/{fileId}?fields=mimeType` con un token OAuth válido.
3. El campo `mimeType` de la respuesta identifica la aplicación: todos los archivos nativos de Workspace tienen el prefijo `application/vnd.google-apps.*`.
4. Si el `mimeType` no tiene ese prefijo, el archivo fue subido desde fuera de Workspace (PDF, imagen, etc.).

**Referencia oficial:** https://developers.google.com/drive/api/guides/mime-types
