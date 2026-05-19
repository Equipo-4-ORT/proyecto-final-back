/**
 * @typedef {Object} ActivityRow
 * Representa una fila de actividad en el reporte/Excel.
 * 
 * @property {string} date - Fecha en formato YYYY-MM-DD
 * @property {string} startTime - Hora de inicio en formato HH:mm
 * @property {string} endTime - Hora de finalización en formato HH:mm
 * @property {number} duration - Duración en horas (calculada)
 * @property {string} source - Origen de la actividad ('calendar', 'drive', 'jira')
 * @property {string} activityType - Tipo de actividad ('meeting', 'edit', 'transition', etc.)
 * @property {string} title - Título o nombre de la actividad
 * @property {string} [description] - Descripción adicional (opcional)
 * @property {string} summary - Resumen generado por IA
 */

/**
 * @typedef {Object} AIModuleOutput
 * Contrato de salida para el módulo de IA.
 * Define la estructura que devuelven todos los adapters de IA.
 * 
 * @property {ActivityRow[]} rows - Array de filas de actividad procesadas
 * @property {number} totalHours - Total de horas trabajadas en el día
 * 
 * @example
 * const output = {
 *   rows: [
 *     {
 *       date: "2026-05-19",
 *       startTime: "09:00",
 *       endTime: "10:00",
 *       duration: 1,
 *       source: "calendar",
 *       activityType: "meeting",
 *       title: "Daily standup",
 *       description: "Team sync",
 *       summary: "Participated in daily team standup discussing sprint progress"
 *     },
 *     {
 *       date: "2026-05-19",
 *       startTime: "10:30",
 *       endTime: "11:45",
 *       duration: 1.25,
 *       source: "drive",
 *       activityType: "edit",
 *       title: "Q2 Planning Doc",
 *       description: "Editing quarterly goals",
 *       summary: "Updated Q2 goals and milestones in planning document"
 *     }
 *   ],
 *   totalHours: 2.25
 * };
 */

module.exports = {};