/**
 * @typedef {Object} ActivityRow
 * Fila del Excel del reporte diario. Representa un bloque horario contiguo.
 * La IA puede agrupar varias actividades del input en una sola fila cuando
 * pertenecen al mismo intervalo horario y a la misma app.
 *
 * @property {string} date - Fecha en formato YYYY-MM-DD
 * @property {string} startTime - Hora de inicio en formato HH:mm (ej: "09:00")
 * @property {string} endTime - Hora de fin en formato HH:mm (ej: "11:00")
 * @property {number} duration - Duración del bloque en minutos (ej: 120 para 2 hs)
 * @property {string} source - Origen ('calendar', 'drive', 'jira')
 * @property {string} app - Nombre user-facing de la app ('Meet', 'Docs', 'Sheets', 'Drive', 'Jira').
 *   La IA lo deriva de `source` + `metadata` del input.
 * @property {string} activityType - Tipo principal del bloque ('meeting', 'edit', 'transition', etc.)
 * @property {string} title - Título o referencia (ej: "PROJ-123", "Reunión Planning")
 * @property {string} [description] - Descripción cruda de la fuente (opcional)
 * @property {string} summary - Resumen del bloque generado por IA
 */

/**
 * @typedef {Object} AIModuleOutput
 * Contrato de salida del módulo de IA. Lo consume el backend para:
 *   (1) escribir el .xlsx con sheetjs — `daySummary` va como header del archivo
 *       y `rows` como contenido tabular ordenado por hora.
 *   (2) componer el cuerpo del email que acompaña al adjunto.
 *
 * @property {string} daySummary - Resumen ejecutivo del día generado por la IA.
 *   Encabeza el Excel y se reutiliza en el cuerpo del email.
 * @property {ActivityRow[]} rows - Filas ordenadas cronológicamente por `startTime`.
 *   Cada fila es un bloque horario contiguo (ej: 09:00–11:00, 11:00–12:00, ...).
 * @property {number} totalHours - Total de horas trabajadas en el día
 *
 * @example
 * const output = {
 *   daySummary: "Jornada enfocada en avance del ticket PROJ-123 y planning de Q2. " +
 *               "Total: 3 hs distribuidas entre Jira (2 hs) y reuniones (1 h).",
 *   rows: [
 *     {
 *       date: "2026-05-19",
 *       startTime: "09:00",
 *       endTime: "11:00",
 *       duration: 120,
 *       source: "jira",
 *       app: "Jira",
 *       activityType: "transition",
 *       title: "PROJ-123",
 *       description: "Update status: To Do -> In Progress",
 *       summary: "Trabajo sobre PROJ-123: transición de estado y worklog registrado"
 *     },
 *     {
 *       date: "2026-05-19",
 *       startTime: "11:00",
 *       endTime: "12:00",
 *       duration: 60,
 *       source: "calendar",
 *       app: "Meet",
 *       activityType: "meeting",
 *       title: "Reunión Planning Q2",
 *       description: "Sync con equipo",
 *       summary: "Participación en planning de Q2 con definición de objetivos"
 *     }
 *   ],
 *   totalHours: 3
 * };
 *
 * @remarks
 * Sanitización (formula injection en Excel): los strings `daySummary`, `title`,
 * `description` y `summary` provienen de fuentes externas (Calendar/Drive/Jira/IA).
 * Antes de escribirlos en celdas del .xlsx, el consumidor DEBE escapar valores
 * que empiecen con `=`, `+`, `-`, `@` (típicamente prefijando un apóstrofo `'`)
 * para evitar que se interpreten como fórmulas al abrir el archivo.
 */

module.exports = {};
