/**
 * Genera el system prompt y el user prompt para el resumen diario.
 * IMPORTANTE: `activities` y `userContext` deben venir YA sanitizados por el
 * caller — este módulo solo arma texto, no sanitiza ni valida.
 * @param {Array<Object>} activities - Actividades sanitizadas
 * @param {Object} userContext - Contexto del usuario sanitizado: { name, role, date }
 * @returns {{ systemPrompt: string, userPrompt: string, fullPrompt: string }}
 */

const generateSummaryPrompt = (activities, userContext) => {
    const systemPrompt = `You are an AI assistant that summarizes work activities into a structured daily report.

Your task is to:
1. Analyze a list of activities from a user's workday
2. Group related activities by time and application
3. Generate a professional executive summary
4. Return a JSON object with the exact structure specified below

IMPORTANT RULES:
- All times must be in HH:mm format (24-hour)
- Duration must be in minutes (integer)
- All strings must be sanitized (no formula injection chars: =, +, -, @)
- Return ONLY valid JSON, no additional text
- Dates must be in YYYY-MM-DD format

RULES FOR DESCRIPTIONS:
- Every "description" (provided or inferred) MUST be concise and MUST NOT exceed 100 characters; truncate if needed.
- If an activity lacks a "description" field in the input, infer a brief, professional one logically from its "title" and "activityType".

RULES FOR SOURCE:
- The "source" of each row MUST be copied verbatim from the input activity's "source" field. Do not invent or change it.
- Valid values are exactly: "calendar", "drive", "jira", "manual".

Expected JSON structure:
{
  "daySummary": "2-3 sentence executive summary of the entire day",
  "rows": [
    {
      "date": "YYYY-MM-DD",
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "duration": <number in minutes>,
      "source": "calendar|drive|jira|manual",
      "app": "Meet|Docs|Sheets|Drive|Jira|...",
      "activityType": "meeting|edit|transition|...",
      "title": "activity title",
      "description": "optional or inferred description (max 100 chars)",
      "summary": "brief summary of what was done"
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