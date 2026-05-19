/**
 * @typedef {Object} Activity
 * @property {string} id - ID único de la actividad
 * @property {string} source - Origen de la actividad ('calendar', 'drive', 'jira')
 * @property {string} activityType - Tipo de actividad ('meeting', 'edit', 'transition', etc.)
 * @property {Date} startTime - Hora de inicio
 * @property {Date} endTime - Hora de finalización
 * @property {Object} [metadata] - Metadatos específicos por aplicación
 * @property {string} [metadata.title] - Título/nombre de la actividad
 * @property {string} [metadata.description] - Descripción (opcional)
 */

/**
 * @typedef {Object} UserContext
 * @property {string} name - Nombre completo del usuario
 * @property {'employee' | 'admin'} role - Rol del usuario en el sistema
 * @property {Date} date - Fecha del informe
 */

/**
 * @typedef {Object} AIModuleInput
 * Contrato de entrada para el módulo de IA.
 * Define la estructura que debe respetar cualquier adapter de IA (OpenAI, Gemini, Claude).
 * 
 * @property {Activity[]} activities - Array de actividades del día del usuario
 * @property {UserContext} userContext - Contexto del usuario
 * 
 * @example
 * const input = {
 *   activities: [
 *     {
 *       id: "abc123",
 *       source: "calendar",
 *       activityType: "meeting",
 *       startTime: new Date("2026-05-19T09:00:00Z"),
 *       endTime: new Date("2026-05-19T10:00:00Z"),
 *       metadata: {
 *         title: "Daily standup",
 *         description: "Team sync"
 *       }
 *     }
 *   ],
 *   userContext: {
 *     name: "Juan Perez",
 *     role: "employee",
 *     date: new Date("2026-05-19")
 *   }
 * };
 */

module.exports = {};
EOF