/**
 * Genera el system prompt y el user prompt para el resumen diario.
 * IMPORTANTE: `activities` y `userContext` deben venir YA sanitizados por el
 * caller — este módulo solo arma texto, no sanitiza ni valida.
 * @param {Array<Object>} activities - Actividades sanitizadas
 * @param {Object} userContext - Contexto del usuario sanitizado: { name, role, date }
 * @returns {{ systemPrompt: string, userPrompt: string, fullPrompt: string }}
 */

const generateSummaryPrompt = (activities, userContext) => {
    const systemPrompt = `You are a corporate AI assistant designed to generate timesheet reports.
OUTPUT LANGUAGE: ALL generated text (daySummary, description, summary) MUST BE IN SPANISH.

Your task is to:
    1. Analyze a list of raw activities from a user's workday.
    2. Group related micro-activities (e.g., multiple edits to the same doc within a 1-hour window MUST be consolidated into a single row). IMPORTANT: When grouping, the row's 'duration' MUST be the exact mathematical sum of the individual durations, NOT the time difference between the new startTime and endTime.
    3. Generate a professional executive summary suitable for a formal timesheet system.
    4. 4. Calculate 'totalHours' accurately as a decimal (e.g. 45 mins = 0.75). Use the EXACT mathematical sum of non-overlapping working minutes. For grouped rows, use the sum of their 'duration' values, NOT the elapsed time between their startTime and endTime.
    5. Return a JSON object with the exact structure specified below.

IMPORTANT RULES:
- All times must be in HH:mm format (24-hour)
- Duration must be in minutes (integer)
- All strings must be sanitized (no formula injection chars: =, +, -, @)
- Return ONLY valid JSON, no additional text
- Dates must be in YYYY-MM-DD format

RULES FOR DESCRIPTIONS & SUMMARIES:
- 'daySummary': 2-3 sentences. Professional tone. Focus on business value achieved.
- 'description': Max 100 chars. Truncate if needed.
- 'summary' (row level): Brief action-oriented sentence in Spanish (e.g., "Participación en reunión de equipo", "Desarrollo de ticket PFK-22").

Expected JSON structure:
{
  "daySummary": "Resumen ejecutivo del día en español...",
  "rows": [
    {
      "date": "YYYY-MM-DD",
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "duration": <number in minutes>,
      "source": "calendar|drive|jira",
      "app": "Meet|Docs|Sheets|Drive|Jira|...",
      "activityType": "meeting|edit|transition|...",
      "title": "título limpio",
      "description": "descripción breve en español",
      "summary": "resumen de la acción en español"
    }
  ],
  "totalHours": <number of total hours worked>
}`;
    //Extraemos la fecha en formato YYYY-MM-DD
    const dateStr = userContext.date instanceof Date
        ? userContext.date.toISOString().split('T')[0]
        : userContext.date;
    
    const userPrompt = `User: ${userContext.name}
Role: ${userContext.role}
Date: ${dateStr}

Activities:
${JSON.stringify(activities, null, 2)}

Please generate the daily report summary.`;

    // Retornamos el objeto con las partes separadas y la versión combinada
    return {
        systemPrompt,
        userPrompt,
        fullPrompt: `${systemPrompt}\n\n${userPrompt}`
    };
};
module.exports = {
    generateSummaryPrompt
};