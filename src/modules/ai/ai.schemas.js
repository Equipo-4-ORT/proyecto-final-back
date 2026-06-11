/**
 * Schemas de validación usando Zod para el módulo de IA.
 * Validamos inputs y outputs para garantizar que cumplan el contrato.
 */

const z = require('zod');
const { AIValidationError } = require('./ai.errors');

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
 * Schema para validar el contexto de usuario que se le pasa al adapter.
 * `date` puede llegar como Date o como string (ISO o YYYY-MM-DD), nunca vacío.
 */
const UserContextSchema = z.object({
    name: z.string().min(1, 'name no puede estar vacío'),
    role: z.string().min(1, 'role no puede estar vacío'),
    date: z.union([z.string().min(1, 'date no puede estar vacío'), z.date()]),
});

/**
 * Formatea los issues de un ZodError en un mensaje legible ("path: message; ...").
 * Defensivo: si no encuentra issues, cae al mensaje del error.
 * @param {*} error
 * @returns {string}
 */
const formatIssues = (error) => {
    const issues = error?.issues ?? error?.errors;
    if (Array.isArray(issues) && issues.length > 0) {
        return issues
            .map((issue) => `${issue.path?.length ? issue.path.join('.') : 'unknown'}: ${issue.message}`)
            .join('; ');
    }
    return error?.message || 'Unknown validation error';
};

/**
 * Valida que un objeto cumple el schema AIModuleOutput.
 * @param {*} data - Datos a validar
 * @returns {Object} Objeto validado
 * @throws {AIValidationError} Si la validación falla
 */
const validateAIModuleOutput = (data) => {
    try {
        return AIModuleOutputSchema.parse(data);
    } catch (error) {
        throw new AIValidationError(`AIModuleOutput validation failed: ${formatIssues(error)}`, {
            cause: error,
        });
    }
};

/**
 * Valida que el contexto de usuario cumple el schema UserContext.
 * @param {*} data - Datos a validar
 * @returns {Object} Contexto validado
 * @throws {AIValidationError} Si la validación falla
 */
const validateUserContext = (data) => {
    try {
        return UserContextSchema.parse(data);
    } catch (error) {
        throw new AIValidationError(`UserContext validation failed: ${formatIssues(error)}`, {
            cause: error,
        });
    }
};

module.exports = {
    UserContextSchema,
    ActivityRowSchema,
    AIModuleOutputSchema,
    validateAIModuleOutput,
    validateUserContext,
};
