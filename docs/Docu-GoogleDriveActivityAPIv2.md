# Endpoint principal

Para obtener el registro de modificaciones de los usuarios, se utilizará el endpoint activity.query de la Google Drive Activity API v2. Este endpoint permite filtrar las actividades mediante rangos de fechas para construir la línea de tiempo diaria.
Filtro recomendado: Utilizar el formato RFC 3339 en la consulta. Ejemplo: time >= "2026-05-22T00:00:00Z" AND time < "2026-05-23T00:00:00Z".
Paginación: Es recomendable establecer un pageSize adecuado en el cuerpo de la petición para procesar la información por lotes y no sobrecargar la memoria.

# Tipos de acciones

La API devuelve un campo llamado primaryActionDetail que especifica qué ocurrió exactamente con un archivo. Para no ensuciar el cálculo de horas efectivas en AutoLog, es crítico filtrar estos eventos en la capa del servicio.

Action Types utilizadas en el proyecto:
EDIT: El usuario modificó el contenido del archivo de forma directa.

CREATE: Un archivo nuevo fue creado o subido al repositorio de Drive.

COMMENT: Interacciones en hilos (crear comentarios, sugerir cambios, resolver).

# Estructura de respuesta

Este es el esquema oficial que el servicio debe parsear. Simula la respuesta de Google conteniendo únicamente los eventos relevantes que superan el filtrado:
{
"activities": [
{
"primaryActionDetail": { "edit": {} },
"actors": [{ "user": { "knownUser": { "personName": "people/123456" } } }],
"targets": [{ "driveItem": { "name": "items/doc1", "title": "Documento de Arquitectura", "mimeType": "application/vnd.google-apps.document" } }],
"timestamp": "2026-05-22T14:30:00.000Z"
},
{
"primaryActionDetail": { "create": { "new": {} } },
"actors": [{ "user": { "knownUser": { "personName": "people/123456" } } }],
"targets": [{ "driveItem": { "name": "items/sheet1", "title": "Planilla de Horas Sprint 3", "mimeType": "application/vnd.google-apps.spreadsheet" } }],
"timestamp": "2026-05-22T09:15:00.000Z"
},
{
"primaryActionDetail": { "comment": { "post": {} } },
"actors": [{ "user": { "knownUser": { "personName": "people/123456" } } }],
"targets": [{ "driveItem": { "name": "items/doc1", "title": "Documento de Arquitectura", "mimeType": "application/vnd.google-apps.document" } }],
"timestamp": "2026-05-22T15:00:00.000Z"
}
]
}

# LIMITE DE CUOTAS

La Drive Activity API tiene un límite estricto establecido por Google de 100.000 peticiones por día por proyecto. Cuando se implemente la integración real en el próximo sprint, el servicio en Node.js deberá contar con un mecanismo de Exponential Backoff (reintentos con tiempos de espera progresivos) para gestionar correctamente los errores HTTP 429 Too Many Requests y evitar caídas en el sistema de sincronización.
