# Endpoint principal y filtrado por rango de fechas

Para obtener el listado de actividades, utilizaremos un metodo llamado "events.list" de la API de google calendar v3 sobre el calendario `'primary'`.

# parametros de filtrado escenciales (`timeMin` y `timeMax`)

para cumplir con el requerimiento de listar actividades dentro del rango de 24 horas marcado por el cliente, debemos inyectar estos parametros:

- **`timeMin`**: Límite inferior del rango de tiempo. Debe enviarse en formato **RFC 3339** (ejemplo: `2026-05-25T00:00:00Z`).
- **`timeMax`**: Límite superior del rango de tiempo en formato **RFC 3339** (ejemplo: `2026-05-26T00:00:00Z`).

# parametros adicionales

- **`singleEvents`**: Debe establecerse en `true`. Esto hace que la API expanda los eventos recurrentes en instancias individuales.
- **`orderBy`**: Configurado en `'startTime'` para que devuelva los eventos ordenados cronológicamente.

# limites de uso

la API de calendar cuenta con un limite diario de 1000000(un millon) de peticiones al dia.

# identificacion de google meet

la API responde los eventos en un array de `items`. Los campos mas importantes son `organizer`, `attendees` (para descartar si el usuario rechazó la invitación), y `hangoutLink`.

No todos los eventos son reuniones. Para clasificar un evento como una usamos `event.conferenceData.conferenceSolution.key.type === 'hangoutsMeet'`
