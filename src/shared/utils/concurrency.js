/**
 * Ejecuta `fn` sobre cada item con un pool de a lo sumo `limit` ejecuciones en
 * simultáneo. A diferencia de procesar en bloques fijos, apenas un "carril"
 * termina toma el siguiente pendiente (sin tiempos muertos). Procesa TODOS los
 * items: solo acota cuántos corren a la vez. Preserva el orden de entrada.
 *
 * Usado por el enriquecido de Drive (files.get) y por el fan-out del scheduler
 * (sincronización por usuario), para no gatillar rate limits de las APIs externas.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit - máximo de ejecuciones concurrentes
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
const mapWithConcurrency = async (items, limit, fn) => {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
};

module.exports = { mapWithConcurrency };
