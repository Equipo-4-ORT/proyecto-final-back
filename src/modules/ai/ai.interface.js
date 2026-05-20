/**
 * Interfaz abstracta para patron adapters de IA.
 * Define el contrato que TODOS los adapters(OpenAI, Gemini, Claude, etc) deben cumplir.
 * 
 * Los adapters heredan de esta clase e implementan el metodo generateSummary()
 * para convertir actividades brutas en un reporte estructurado (AIModuleOutput)
 * 
 * @abstract
 * @class AIAdapter
 * 
 * @example
 * class OpenAIAdapter extends AIAdapter {
 * async generateSummary(activities, userContext){
 *  //implementacion especifica de OpenAI
 *  return {daySummary: "...", rows: [...], totalHours: 8};
 *  }
 * }
 */
class AIAdapter {
    /**
     * Genera un resumen ejecutivo y detallado de las actividades del dia.
     * 
     * @abstract
     * @async
     * @param {Array<Activity>} activities - Array de las atividades del dia del usuario
     * @param {UserContext} userContext - Contexto del usuario (nombre, rol, fecha)
     * @returns {Promise<AIModuleOutput>} - Promise que resuelve a un objeto con daySummary,
     * @throws {Error} si el metodo no es implementado por la clase
     * 
     * @example
     * const adapter = new OpenAIAdapter();
     * const output = await adapter.generateSummary(activities, userContext);
     * // output = {daySummary: "...", rows: [...], totalHours: 8 }
     */
    async generateSummary(activities, userContext) {
        throw new Error('generateSummary() must be implemented by subclass');
    }
}

module.exports = AIAdapter;