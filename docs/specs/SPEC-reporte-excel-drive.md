# SPEC (Funcional) — Google Sheet del reporte diario guardado en Drive

> Especificación **funcional** (estilo SDD — *Spec-Driven Development*). Describe **qué** debe hacer el sistema y **por qué**, no el cómo. El cómo (Sheets API, contratos, manejo de errores) va en la spec técnica asociada.

| | |
|---|---|
| **Feature ID** | `F7-01` (tentativo — confirmar numeración con el backlog; ver §13.1) |
| **Estado** | Implementada |
| **Fecha** | 2026-06-13 |
| **Autor(es)** | Equipo 4 |
| **Spec técnica** | [SPEC-TEC-reporte-excel-drive](./SPEC-TEC-reporte-excel-drive.md) |
| **ADR relacionado** | ninguno |
| **Módulo destino** | `src/modules/reports/` |

---

## 1. Propósito

Cuando un empleado genera el reporte de su jornada, además de la previsualización que ya existe hoy, el sistema debe **crear un Google Sheet con el detalle de ese día en el Drive de la cuenta de Google que el empleado conectó**, de modo que quede un entregable persistente y descargable, accesible desde su propia cuenta. El historial de estos archivos se consulta desde la sección de historial del dashboard.

## 2. Objetivos y No-objetivos

**Objetivos** *(lo que esta spec SÍ cubre)*
- Al generar un reporte (`POST /reports/generate`), construir un **Google Sheet nativo** a partir del contenido ya generado por la IA (`daySummary`, `rows`, `totalHours`).
- Crear ese Sheet en el Drive del propio empleado **usando el scope `spreadsheets` que ya tiene otorgado** (sin pedir permisos nuevos).
- Persistir el enlace al Sheet en `Report.xlsxUrl` y devolverlo al frontend para descargar/abrir.
- Permitir que la sección **/historial** liste los reportes generados (desde la base de datos) con su enlace al Sheet.
- Garantizar **una única generación por día**: una vez creado el reporte de una fecha, no se vuelve a generar ni se sobrescribe el Sheet.
- Garantizar que el contenido de texto escrito en las celdas no se interprete como **fórmula** (formula injection).
- Mantener intacto el comportamiento actual del endpoint (previsualización, idempotencia, detección de solapamientos): el Sheet es un agregado, no un reemplazo.

**No-objetivos** *(fuera de alcance de ESTA spec — cada ítem dice por qué)*
- **Validación contra prompt injection** del contenido de la IA — *porque ya está resuelta en el pipeline actual (`ai.sanitize.js`).*
- **Archivo binario `.xlsx`** descargado/subido a Drive — *se descartó: el Sheet nativo cubre la necesidad con el scope ya otorgado y sin re-consentimiento (ver §14.4).*
- **Organizar los Sheets en una carpeta `reportes-autolog`** — *requiere el scope de escritura `drive.file` y re-consentimiento; se difiere (ver §13.2 y §15). El Sheet se crea en la raíz de "Mi unidad".*
- **Elección/uso de una librería de Node para armar `.xlsx`** — *ya no aplica: se usa la Sheets API de Google directamente.*
- **Envío del Sheet por email** — *el email del batch es solo aviso + link al dashboard (ver SPEC del batch diario).*
- **Re-generar o versionar el Sheet** ante reediciones — *cada día es de generación única (RN-03); no hay versionado.*

## 3. Actores y permisos

| Actor / Rol | Descripción | Qué puede hacer en esta feature |
|---|---|---|
| **EMPLOYEE** (`ACTIVE`) | Usuario dueño de la jornada, con Google conectado. | Generar su reporte, obtener el Sheet en **su** Drive y verlo en su historial. |
| **Sistema (backend)** | El flujo de generación de reporte. | Crea el Sheet en el Drive del empleado dueño del reporte. |
| **Otro EMPLOYEE / ADMIN** | Cualquier otro usuario. | **NO** puede generar el reporte de otro ni acceder a su Sheet. El archivo vive en el Drive del dueño, no en uno compartido. |

> El Sheet se crea **únicamente** en el Drive del empleado autenticado en la request (`req.user`). No se escribe en Drives de terceros ni en una cuenta de servicio compartida.

## 4. Supuestos y dependencias

- **Decisiones ya tomadas:**
  - El Sheet se crea **on-demand** dentro de `POST /reports/generate`, no en el batch diario.
  - Se usa un **Google Sheet nativo** (vía Sheets API), no un binario `.xlsx`.
  - Se usa el scope `spreadsheets` **ya otorgado**; no se piden permisos nuevos en este alcance.
  - El Sheet se crea en la **raíz** del Drive del empleado (sin carpeta dedicada por ahora).
  - El contenido del Sheet se arma a partir del `AIModuleOutput` existente (`daySummary` como encabezado, `rows` como tabla ordenada por hora, `totalHours`).
  - **Generación única por día:** no se sobrescribe ni se regenera el reporte/Sheet de una fecha ya generada.
- **Servicios / módulos existentes de los que depende:**
  - Generación de reporte (`reports.service.generateReportForDate`) y modelo `Report` (el campo `xlsxUrl` **ya existe**, `VarChar(255)`).
  - Cliente OAuth de Google autenticado (`google.service.getAuthenticatedGoogleClient`) y `googleapis` (Sheets API).
  - Sanitización de texto ya aplicada al contenido de la IA.
  - Historial de reportes ya existente (`GET /reports`), que devuelve `xlsxUrl` por reporte.
- **Supuestos sobre el entorno:**
  - El empleado tiene Google conectado y su refresh token es válido (si fue revocado, `User.googleReconnectRequired = true`).
  - El contenido del reporte (`Report.content`) ya pasó las validaciones de prompt injection.
  - El unique `[userId, reportDate]` del modelo `Report` garantiza un único reporte (y por ende un único Sheet) por día.

## 5. Casos de Uso

### CU-01 — Generar reporte y crear su Sheet en Drive
- **Actor:** EMPLOYEE (`ACTIVE`).
- **Precondición:** Tiene actividades para la fecha, Google conectado, y aún no generó el reporte de ese día.
- **Disparador:** `POST /reports/generate` con `{ date }`.
- **Flujo principal:**
  1. El sistema valida la fecha y resuelve el reporte como hoy (idempotencia, solapamientos, llamada a IA, persistencia con `status PENDING`).
  2. Con el contenido del reporte, el sistema crea un Google Sheet (título = fecha del reporte; encabezado con el resumen del día + tabla de actividades + total de horas).
  3. El sistema persiste el `spreadsheetUrl` en `Report.xlsxUrl`.
  4. El sistema responde con la previsualización **y** el enlace al Sheet.
- **Postcondición:** Existe un Sheet en el Drive del empleado y `Report.xlsxUrl` apunta a él.
- **Flujos alternativos / excepciones:**
  - `1a.` Ya existe un reporte para la fecha (`SENT` o `PENDING`) → se mantiene la respuesta idempotente actual; se devuelve el `xlsxUrl` existente sin crear un Sheet nuevo (RN-03, E-05).
  - `2a.` El contenido tiene celdas que empezarían con `=`/`+`/`-`/`@` → se escriben de forma que no se interpreten como fórmula (V-03).
  - `3a.` Falla la creación del Sheet (Drive/Sheets caído, token revocado) → el reporte **se guarda igual** en `PENDING` con `xlsxUrl = null`; no se aborta la generación (E-06, §14.2).

### CU-02 — Ver el historial de Sheets generados
- **Actor:** EMPLOYEE.
- **Precondición:** Tiene uno o más reportes generados.
- **Disparador:** El usuario abre la sección **/historial** del dashboard.
- **Flujo principal:**
  1. El frontend consulta `GET /reports` (historial respaldado por la base de datos).
  2. Cada reporte con `xlsxUrl` no nulo muestra un enlace para abrir su Sheet en Drive.
- **Postcondición:** El usuario accede a cualquiera de sus Sheets desde el historial.
- **Flujos alternativos:**
  - `1a.` Un reporte tiene `xlsxUrl` nulo (generado antes de esta feature, o cuya creación de Sheet falló) → se muestra sin enlace de descarga.

## 6. Reglas de Negocio

| ID | Regla |
|---|---|
| **RN-01** | El Sheet se arma exclusivamente a partir del contenido ya generado del reporte (`daySummary`, `rows`, `totalHours`); no se recalcula la actividad. |
| **RN-02** | El Sheet se crea en el Drive del **empleado dueño** del reporte y de ningún otro. |
| **RN-03** | **Generación única:** una fecha ya reportada no se vuelve a generar ni su Sheet se sobrescribe. El título del Sheet es la fecha del reporte (`YYYY-MM-DD`), reflejo de esa unicidad. |
| **RN-04** | El texto proveniente de fuentes externas/IA se escribe en el Sheet de forma que **no pueda interpretarse como fórmula**. |
| **RN-05** | El historial de Sheets es el historial de reportes de la base de datos (`GET /reports`), no una lectura del Drive. |
| **RN-06** | Si la creación del Sheet falla, el reporte queda generado igual (`PENDING`, `xlsxUrl = null`); la falta de Sheet no invalida el reporte. |

## 7. Validaciones

| ID | Validación | Cuándo | Si falla |
|---|---|---|---|
| **V-01** | `date` presente y con formato válido. | Al recibir la request. | `400` (comportamiento actual, sin cambios). |
| **V-02** | El usuario tiene Google conectado con token válido. | Antes de crear el Sheet. | El reporte se guarda en `PENDING` con `xlsxUrl = null`; si el token está revocado se marca `googleReconnectRequired` (E-07). |
| **V-03** | Ninguna celda de texto se interpreta como fórmula. | Al escribir el Sheet. | Se neutraliza (la celda se escribe como texto literal); no se aborta. |
| **V-04** | El `spreadsheetUrl` cabe en `VarChar(255)`. | Antes de persistir. | El enlace estándar de Sheets entra holgado; si no, se persiste `null` antes que truncar a un enlace inválido. |

## 8. Casos borde

| ID | Caso | Comportamiento esperado |
|---|---|---|
| **E-01** | Reporte sin actividades. | No aplica: el flujo actual aborta con `400` antes de crear nada. El Sheet solo se arma sobre un reporte válido. |
| **E-02** | Texto con Unicode / emojis / caracteres especiales. | Se escriben correctamente en el Sheet, sin corromper el contenido. |
| **E-03** | Día con muchas actividades (tabla grande). | El Sheet se crea con todas las filas; no debe degradar la respuesta de forma perceptible (RNF-01). |
| **E-05** | **Idempotencia:** se vuelve a pedir generar un reporte ya existente. | No se crea un Sheet nuevo: se devuelve el `xlsxUrl` ya persistido (RN-03). |
| **E-06** | Drive/Sheets caído, lento o con error. | El reporte se guarda en `PENDING` con `xlsxUrl = null`; el usuario puede reintentar más adelante. Nunca se devuelve stack trace. |
| **E-07** | El usuario revocó el permiso de Google entre la conexión y la generación. | Se detecta, se marca `googleReconnectRequired` y se guarda el reporte sin Sheet; no rompe el flujo. |

## 9. Criterios de Seguridad

| ID | Criterio | Detalle |
|---|---|---|
| **SEC-01** | **Autenticación** | El endpoint requiere JWT válido (middleware actual); sin token → `401`. |
| **SEC-02** | **Autorización** | El Sheet se crea SOLO en el Drive del `userId` del token. No se acepta un `userId`/destino externo en el body; se evita acceso horizontal. |
| **SEC-03** | **Validación y sanitización de input** | Reutiliza la sanitización existente del contenido + neutralización anti-fórmula al escribir celdas (V-03). |
| **SEC-04** | **Datos sensibles** | El refresh token de Google se usa descifrado solo en memoria; nunca se loguea ni se devuelve. |
| **SEC-05** | **Mínima exposición** | La respuesta agrega únicamente el enlace al Sheet; no filtra IDs internos innecesarios ni datos de terceros. |
| **SEC-06** | **Rate limiting / abuso** | Se mantiene el `apiLimiter` actual; la generación única por día (RN-03) evita la creación masiva de archivos. |
| **SEC-07** | **Auditoría** | Se loguea la creación del Sheet (quién, qué reporte, éxito/fallo) sin volcar contenido del reporte ni PII innecesaria. |

## 10. Requisitos No Funcionales

| ID | Requisito |
|---|---|
| **RNF-01** | *Rendimiento:* la creación del Sheet (llamada a Sheets API) no debe hacer sentir colgado el endpoint; es la parte más lenta y dependiente de red. |
| **RNF-02** | *Observabilidad:* logs estructurados de éxito/fallo de creación (con `reportId`, `userId`), sin PII ni contenido del reporte. |
| **RNF-03** | *Resiliencia:* un fallo de Sheets/Drive degrada a `xlsxUrl = null` (RN-06), sin dejar el reporte en estado corrupto. |
| **RNF-04** | *Configurabilidad:* lo que sea ambiental se controla por configuración, no hardcodeado. |

## 11. Scope de cambio

**Se modifica / crea:**
- `src/modules/reports/reports.service.js` — tras generar el contenido, crear el Sheet, guardar `xlsxUrl` y manejar el fallo degradando a `null`.
- Respuesta de `POST /reports/generate` — incluir el `xlsxUrl` en el payload devuelto.
- Posible nuevo helper/módulo para construir el Sheet vía Sheets API (a definir en spec técnica).

**Se deja intacto (y por qué):**
- **Scopes OAuth** (`auth.service.js`) — el scope `spreadsheets` ya otorgado alcanza; **no** se agrega `drive.file` en este alcance.
- Pipeline de IA y su sanitización anti prompt injection — ya cubre su responsabilidad.
- Lógica de idempotencia y detección de solapamientos del reporte — no cambia.
- Esquema de BD: el campo `Report.xlsxUrl` ya existe; **no** requiere migración.
- Historial: `GET /reports` ya devuelve `xlsxUrl`; lo consume el frontend sin cambios de contrato.

**Impacto en otros consumidores / contratos:**
- El frontend gana el campo `xlsxUrl` poblado en la respuesta de generación y en el historial; es **aditivo**, no rompe el contrato actual.
- Sin re-consentimiento de permisos para los usuarios (se usa el scope existente).

## 12. Criterios de Aceptación

- **CA-01 (CU-01, RN-01):** *Dado* un empleado con actividades y Google conectado, *cuando* genera el reporte de una fecha, *entonces* se crea un Google Sheet en su Drive con el resumen, la tabla de actividades y el total de horas, y la respuesta incluye su `xlsxUrl`.
- **CA-02 (SEC-02):** *Dado* un empleado autenticado, *cuando* genera su reporte, *entonces* el Sheet se crea en **su** Drive y nunca en el de otro, aunque el body intente indicar otro destino.
- **CA-03 (RN-04, V-03):** *Dado* un contenido con un campo que empieza con `=`, *cuando* se escribe en el Sheet, *entonces* la celda queda como texto literal y no se ejecuta como fórmula.
- **CA-04 (RN-03, E-05):** *Dado* un reporte ya generado de una fecha, *cuando* se vuelve a pedir generarlo, *entonces* no se crea un Sheet nuevo ni se sobrescribe el existente, y se devuelve el `xlsxUrl` ya persistido.
- **CA-05 (RN-06, E-06):** *Dado* Sheets/Drive caído o el token revocado, *cuando* se intenta crear el Sheet, *entonces* el reporte se guarda en `PENDING` con `xlsxUrl = null`, sin stack trace, y el usuario puede reintentar.
- **CA-06 (CU-02, RN-05):** *Dado* un empleado con reportes generados, *cuando* abre /historial, *entonces* ve sus reportes desde la base de datos, cada uno con enlace a su Sheet cuando `xlsxUrl` no es nulo.

## 13. Cuestiones abiertas

1. **Feature ID / numeración** en el backlog/MVP (tentativo `F7-01`). *Bloquea:* no. *Responsable:* equipo.
2. **Permisos de compartición del Sheet:** ¿queda privado del dueño (default) o se comparte con alguien (p. ej. su manager)? *Bloquea:* no. *Responsable:* equipo.

## 14. Cuestiones resueltas

1. **Medio de entrega:** Google Sheet nativo creado vía Sheets API, en lugar de un binario `.xlsx` subido — *usa el scope ya otorgado y evita re-consentimiento — 2026-06-13, equipo.*
2. **Política ante fallo de creación del Sheet:** el reporte se guarda igual en `PENDING` con `xlsxUrl = null`; el usuario reintenta — *2026-06-13, equipo (RN-06, E-06).*
3. **Generación única / sobrescritura:** ningún reporte se sobrescribe; cada día es de generación única y el título del Sheet es la fecha — *2026-06-13, equipo (RN-03).*
4. **Scope OAuth:** no se agrega `drive.file`; alcanza `spreadsheets` ya otorgado (a costa de no usar carpeta por ahora) — *2026-06-13, equipo.*
5. **Destino:** raíz de "Mi unidad" del empleado, **sin carpeta dedicada** (decisión confirmada: no se usa carpeta en este MVP) — *2026-06-13, equipo.*
6. **Qué se persiste en `xlsxUrl`:** el `spreadsheetUrl` del Sheet (`https://docs.google.com/spreadsheets/d/{id}/edit`), que entra en `VarChar(255)` — *2026-06-13, equipo.*

## 15. Fuera de alcance

- Carpeta `reportes-autolog` y, en general, organización de archivos en Drive (requiere `drive.file`; iteración futura).
- Adjuntar el Sheet al email del batch (el email sigue siendo aviso + link al dashboard).
- Versionado/historial de Sheets por reporte (cada día es de generación única).
- Exportación a otros formatos (PDF, CSV, `.xlsx` binario).
- Generar el Sheet para reportes históricos previos a esta feature (no hay backfill).

## 16. Referencias

- Contrato de salida de la IA y nota sobre formula injection: `src/modules/ai/ai.output.types.js`.
- Flujo actual de generación: `src/modules/reports/reports.service.js` (`generateReportForDate`).
- Historial de reportes: `getReportsHistory` en el mismo archivo y `GET /reports`.
- Modelo `Report` (campo `xlsxUrl` ya existente): `prisma/schema.prisma`.
- Scopes OAuth de Google (`spreadsheets` ya otorgado): `src/modules/auth/auth.service.js`.
- Cliente Google autenticado: `src/modules/google/google.service.js`.
- SPEC del batch diario (relación email vs. entregable): `docs/specs/SPEC-batch-diario-sincronizacion.md`.
