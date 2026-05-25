/**
 * Schemas de validación usando Zod para el módulo de IA.
 * Validamos inputs y outputs para garantizar que cumplan el contrato.
 */

const z = require('zod');

/**
 * Schema para validar un ActivityRow (fila del Excel).
 * Cada fila es un bloque horario contiguo.
 */
const ActivityRowSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato debe ser YYYY-MM-DD'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato debe ser HH:mm'),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato debe ser HH:mm'),
    duration: z.number().int().positive('Duration debe ser positivo'),
    source: z.enum(['calendar', 'drive', 'jira']),
    app: z.string().min(1, 'App no puede estar vacío'),
    activityType: z.string().min(1, 'ActivityType no puede estar vacío'),
    title: z.string().min(1, 'Title no puede estar vacío'),
    description: z.string().optional(),
    summary: z.string().min(1, 'Summary no puede estar vacío'),
});

/**
 * Schema para validar el output completo del módulo de IA.
 * Lo que la IA debe devolver para que el backend pueda usarlo.
 */
const AIModuleOutputSchema = z.object({
    daySummary: z.string().min(1, 'daySummary no puede estar vacío'),
    rows: z.array(ActivityRowSchema).min(1, 'Debe haber al menos una fila'),
    totalHours: z.number().positive('totalHours debe ser positivo'),
});

/**
 * Valida que un objeto cumple el schema AIModuleOutput.
 * @param {*} data - Datos a validar
 * @returns {Object} Objeto validado
 * @throws {Error} Si la validación falla
 */
const validateAIModuleOutput = (data) => {
    try {
        return AIModuleOutputSchema.parse(data);
    } catch (error) {
        const messages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        throw new Error(`AIModuleOutput validation failed: ${messages.join('; ')}`, { cause: error });
    }
};

module.exports = {
    ActivityRowSchema,
    AIModuleOutputSchema,
    validateAIModuleOutput,
};