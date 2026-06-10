# Historial de versiones del Prompt: Resumen Diario (AI)

## v1.0 (Inicial - Autor: Santiago)

- **Estado:** Deprecado
- **Enfoque:** Estructura básica JSON, validación de formatos (HH:mm) y sanitización contra inyección de fórmulas.
- **Problemas detectados en testing:**
  1. Redactaba todo el contenido en inglés.
  2. Sumaba linealmente las horas de eventos solapados (inflando el totalHours).
  3. No agrupaba correctamente las micro-actividades (spam de filas).

## v2.0 (Iteración de Idioma y Agrupación)

- **Estado:** Deprecado
- **Mejoras:**
  - Se forzó el OUTPUT LANGUAGE a Español.
  - Se instruyó agrupar micro-actividades en bloques de 1 hora.
- **Problemas detectados:**
  - Fallo matemático: Al agrupar filas, la IA restaba la hora de fin con la hora de inicio en lugar de sumar los minutos reales de trabajo, inflando nuevamente el `totalHours`.

## v3.0 (Actual / Producción - Autor: Felipe)

- **Estado:** Activo
- **Mejoras definitivas implementadas:**
  - **Contexto Corporativo:** Tono "professional executive summary" para timesheets.
  - **Matemática estricta (Regla 4):** Instrucciones explícitas de calcular la suma matemática exacta de los minutos no-solapados para los bloques agrupados, evitando que la IA infle el tiempo total.
  - **Resultado:** JSON impecable en español con horas exactas (Ej: test Escenario B calculó 2.75hs reales frente a las 3hs nominales).
