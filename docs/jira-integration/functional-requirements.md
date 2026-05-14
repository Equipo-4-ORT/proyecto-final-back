# Requerimientos Funcionales — Integración Jira

## 0. Metadata

| Campo                          | Valor                                                       |
| ------------------------------ | ----------------------------------------------------------- |
| Módulo                         | `jira`                                                      |
| Feature / Épica                | F2B — Integración Jira API (alcance MVP)                    |
| Autor(es)                      | Martín (PL · Backend SSR)                                   |
| Estado                         | Draft (rev. 4)                                              |
| Fecha creación                 | 2026-05-09                                                  |
| Última revisión                | 2026-05-10                                                  |
| Issue / Ticket                 | F2B-01 a F2B-06 (ver `documentation/gantt.md`)              |
| Documento técnico relacionado  | [docs/jira-integration/technical-requirements.md](./technical-requirements.md) |

---

## 1. Contexto y motivación

Los colaboradores de las empresas que adoptan la plataforma trabajan diariamente con Jira para gestionar tickets, registrar comentarios y avanzar estados. Esa actividad no aparece hoy en la timeline del MVP — que solo consume Google Calendar y Drive — y por lo tanto el resumen de IA queda incompleto frente a una jornada típica de desarrollo o gestión de proyectos.

- **Problema:** la jornada laboral incluye trabajo en Jira que no se está capturando, lo que produce informes que subestiman lo realizado.
- **Origen del requerimiento:** validación con cliente (Marcelo Baldini, Finegans) en W2 — Jira fue confirmado como **MUST del MVP**, no opcional. Finegans es el cliente piloto.
- **Impacto si no se hace:** el resumen generado por IA omite una porción significativa del trabajo del día → el informe diario pierde fidelidad y el colaborador termina editando manualmente, anulando la propuesta de valor.

> **Nota de modelo de distribución (fuera del scope de este FRD pero asumido):** la plataforma se distribuye como **software self‑hosted por empresa** — cada cliente recibe el código y lo despliega en sus propios servidores. Cada deployment es **single‑tenant por definición** (una empresa = una instancia = una BD). El código se entrega con una **key de bootstrap** que la empresa usa una sola vez para crear su `ADMIN`; ese admin después gestiona el CRUD de sus usuarios (no hay autocreación al loguear, no hay upsert). Esta integración Jira asume ese modelo: los usuarios deben existir en la BD antes de poder iniciar el flujo de conexión a Jira. Las features de "gestión de usuarios por admin" y "bootstrap del admin con key" son features separadas, no parte de este FRD.
> **Implicancia clave para Jira:** cada empresa también registra **su propia app OAuth en developer.atlassian.com** apuntando a la URL de su deployment, y configura sus propias `JIRA_CLIENT_ID`/`JIRA_CLIENT_SECRET` en su `.env`. No hay credenciales compartidas entre customers.

---

## 2. Stakeholders y usuarios

| Rol                       | Quién es                                            | Qué espera de la feature |
| ------------------------- | --------------------------------------------------- | ------------------------ |
| Empleado (`EMPLOYEE`)     | Colaborador que usa Jira como parte de su jornada    | Conectar su cuenta una vez. Que la actividad de Jira aparezca en su timeline diario. Poder reconectar/desconectar sin perder histórico ya importado. Configurar el horario de fin de su jornada para que el sync corra al cierre. |
| Administrador (`ADMIN`)   | Responsable de gestionar los usuarios de su empresa (CRUD)  | **No interviene en el flujo de Jira de cada colaborador.** No aprueba informes ni recibe alertas por conexiones Jira rotas. Su única responsabilidad relevante para esta integración es haber creado al usuario en la BD (precondición). La conexión Jira es self‑service del propio empleado. |
| Sistema externo — Jira Cloud | Fuente de actividad gestionada por Atlassian      | Recibir solicitudes autenticadas (OAuth 3LO) dentro de los rate limits, devolver issues / changelog / worklog del usuario. |

> Roles consistentes con el `enum Role` actual de `prisma/schema.prisma`. No se introduce un nuevo rol en este FRD.
> Como la plataforma es **self‑hosted por empresa**, no se modela una entidad `Company` en BD: el "tenant" es el propio deployment. Los `User` de una instancia son, por construcción, todos de la misma empresa.

---

## 3. Alcance

### 3.1. In scope

- [ ] **Validación de usuario existente:** antes de iniciar el flujo OAuth, el sistema verifica que el usuario autenticado existe en la BD (creado previamente por el admin de su empresa). Si no existe → error explícito, sin autocreación.
- [ ] El colaborador puede **conectar** su cuenta de Jira mediante el flujo OAuth 2.0 (3LO) de Atlassian.
- [ ] El sistema **persiste el refresh token cifrado** y el `cloudId` del site Atlassian del usuario.
- [ ] El sistema expone una operación de sincronización que, **dado un `userId` y una ventana de tiempo `(desde, hasta)`**, recolecta la actividad de ese usuario en Jira dentro de esa ventana. _Quién decide cuándo y con qué ventana invocar al sync (orquestador / cron / endpoint manual) está fuera del scope de este FRD._
- [ ] La actividad de Jira se **persiste como `DailyActivity` con `source = 'jira'`** y se integra a la timeline consolidada que alimenta a la IA.
- [ ] El colaborador puede **ver el estado de su conexión** (conectado / desconectado / requiere reconectar) y la fecha de la última sincronización exitosa.
- [ ] El colaborador puede **desconectar** su cuenta de Jira.
- [ ] Si el `refresh_token` deja de funcionar, el sistema marca al usuario como "requiere reconectar" sin romper otras integraciones (Google sigue funcionando) y sin notificar al admin (es problema del usuario).
- [ ] El informe diario consolidado (con la actividad Jira incluida) se **persiste en la base de datos** (modelo `Report` ya existente — esta integración solo agrega entradas en `DailyActivity`).

### 3.2. Out of scope (explícito)

- [ ] **Gestión de usuarios (CRUD por admin)** — feature separada que esta integración asume YA EXISTENTE. Sin esa feature, ningún usuario puede usar Jira porque no existe en la BD.
- [ ] **Bootstrap del admin con la key** — feature separada de provisionamiento. El código se entrega con una key; la empresa la usa una vez para crear su admin inicial.
- [ ] **Multi‑tenancy dentro de una instancia.** No aplica: la plataforma es self‑hosted por empresa, no se modela `Company` en BD. Si en el futuro se decidiera ofrecer una versión SaaS multi‑tenant, sería un rediseño separado.
- [ ] **Notificaciones al admin** sobre conexiones Jira rotas, reconexiones o estado de la integración de cada colaborador. El admin no es stakeholder operativo de Jira.
- [ ] **Aprobación de informes por parte del admin** — los informes los aprueba el propio colaborador (ver F4-04 en el Gantt).
- [ ] **Crear, editar, comentar, transicionar o asignar issues** desde la app. Esta feature es **solo de lectura**.
- [ ] **Sincronización en tiempo real** vía webhooks de Jira. Mantenemos el modelo batch del MVP.
- [ ] **Reportes analíticos exclusivos de Jira** (ej: tickets por sprint, lead time). El uso de los datos es consolidación en la timeline, no analítica.
- [ ] **Múltiples sites Atlassian por usuario.** Si el usuario tiene acceso a más de uno, se toma el primero accesible (foco en la actividad del usuario, no en orquestar varios sites).
- [ ] **Soporte para Jira Server / Data Center on‑prem.** Solo Jira Cloud.
- [ ] **Importación histórica.** La sincronización empieza desde el día en que el usuario se conecta; no se hace backfill de actividad previa.
- [ ] **Frontend (componentes React).** Esta integración define el contrato de API que el front consumirá; el componente vive en el repo de frontend (ver F2B-06 en el Gantt).
- [ ] **Configuración de la jornada laboral del usuario** y el **orquestador / cron** que decide cuándo invocar al sync — features separadas. Esta integración **no consulta** la jornada; solo recibe del caller la ventana `(desde, hasta)` que debe sincronizar.

---

## 4. Historias de usuario

### HU-01 — Conectar mi cuenta de Jira

**Como** colaborador (`EMPLOYEE`),
**quiero** vincular mi cuenta de Atlassian a la app autorizando los permisos mínimos necesarios,
**para** que mi actividad diaria en Jira se incorpore al informe automatizado.

#### Criterios de aceptación

```gherkin
Escenario: Colaborador autoriza la conexión por primera vez
  Dado que estoy autenticado en la app
  Y    que mi usuario existe en la BD (creado por el admin de mi empresa)
  Y    que NO tengo una conexión Jira activa
  Cuando inicio el flujo de conexión a Jira desde el frontend
  Entonces el backend me redirige a la pantalla de autorización de Atlassian
  Y    la URL de autorización incluye los scopes mínimos definidos por el equipo
  Y    incluye un parámetro `state` no predecible (CSRF protection)

Escenario: Sesión válida pero sin user en BD (caso edge tras eliminación por admin)
  Dado que tengo una sesión válida pero mi user fue eliminado por el admin
  Cuando inicio el flujo de conexión a Jira
  Entonces el backend responde 404 con error tipificado "user_not_found"
  Y    NO se genera state ni se redirige a Atlassian
  Y    el evento queda registrado en logs como `warn`

Escenario: Atlassian devuelve el callback con autorización exitosa
  Dado que autoricé la app en Atlassian
  Cuando Atlassian redirige al callback con un `code` y el `state` válido
  Entonces el backend intercambia el code por un access_token + refresh_token
  Y    obtiene el `cloudId` del site principal del usuario
  Y    persiste el refresh_token cifrado, el cloudId y el siteUrl asociados al usuario
  Y    marca al usuario como "Jira conectado"
  Y    NO devuelve los tokens al frontend en ningún momento

Escenario: El callback recibe un `state` que no coincide con el emitido
  Dado un intento de callback con un `state` inválido o vencido
  Cuando el backend procesa el callback
  Entonces responde con error tipificado (ver doc técnico, status 400)
  Y    NO persiste credenciales
  Y    el evento queda registrado en logs como `warn`

Escenario: El usuario cancela la autorización en Atlassian
  Dado que estaba en la pantalla de consentimiento de Atlassian
  Cuando rechazo otorgar los permisos
  Entonces Atlassian redirige al callback con `error=access_denied`
  Y    el backend responde sin persistir nada
  Y    el frontend recibe un mensaje claro de "Conexión cancelada"
```

---

### HU-02 — Mi actividad de Jira aparece en mi timeline diario

**Como** colaborador,
**quiero** que las acciones que hago en Jira durante mi jornada (tickets en los que trabajé, comentarios, transiciones, worklogs)
**se incorporen automáticamente** a mi timeline,
**para** revisarlas y aprobar el informe sin tener que cargarlas a mano.

> **Nota:** la decisión de _cuándo_ invocar al sync y _con qué ventana_ está fuera del scope de este FRD. Esta HU describe el comportamiento del módulo Jira **una vez invocado** con `(userId, desde, hasta)`.

#### Criterios de aceptación

```gherkin
Escenario: Sync con actividad Jira en la ventana solicitada
  Dado que tengo Jira conectado
  Y    que entre 09:00 y 18:00 comenté 2 tickets, transicioné 1 y registré 1 worklog
  Cuando el sync se invoca con (userId=mio, desde=09:00, hasta=18:00)
  Entonces se persisten 4 entradas DailyActivity con source='jira' dentro de esa ventana
  Y    cada entrada tiene los campos básicos del ticket en metadata (issue_key, summary, status, project_key)
  Y    el sync devuelve cantidad importada y duración

Escenario: Ventana sin actividad en Jira
  Dado que tengo Jira conectado pero no toqué ningún ticket entre la ventana solicitada
  Cuando el sync se invoca con esa ventana
  Entonces no se persisten DailyActivity con source='jira'
  Y    el sync devuelve cantidad importada = 0 (sin error)

Escenario: Acciones fuera de la ventana se ignoran
  Dado que tengo Jira conectado
  Y    que comenté un ticket a las 08:30 y otro a las 10:00
  Cuando el sync se invoca con (desde=09:00, hasta=18:00)
  Entonces solo se persiste el comentario de las 10:00
  Y    el comentario de las 08:30 NO se importa (queda fuera de la ventana)

Escenario: Idempotencia — el sync se invoca dos veces sobre la misma ventana
  Dado que el sync ya importó actividad para (userId, ventana) dada
  Cuando el sync se ejecuta nuevamente con los mismos parámetros (re-trigger manual o recovery)
  Entonces NO se duplican entradas en DailyActivity
  Y    las entradas ya persistidas no se modifican

Escenario: Ventana inválida
  Dado un caller (orquestador / endpoint manual) que invoca el sync
  Cuando los parámetros tienen `desde >= hasta` o están ausentes
  Entonces el sync responde con error tipificado (400 si vino por endpoint)
  Y    NO se realiza ninguna llamada a Atlassian

Escenario: El usuario solo tiene visibilidad limitada en Jira
  Dado que mi cuenta Atlassian solo ve issues de un proyecto X
  Cuando el sync recolecta mi actividad
  Entonces solo se importan acciones sobre issues que mi cuenta puede ver
  Y    el sistema NO intenta acceder a issues fuera de mis permisos
```

---

### HU-03 — Reconectar o desconectar mi cuenta de Jira

**Como** colaborador,
**quiero** poder ver el estado de mi conexión a Jira y desconectarla cuando lo necesite,
**para** mantener control sobre mis credenciales y poder reconectar si rotan tokens.

#### Criterios de aceptación

```gherkin
Escenario: El usuario consulta su estado de conexión
  Dado que estoy autenticado
  Cuando consulto el endpoint de estado Jira
  Entonces recibo: { connected: bool, lastSyncAt, siteUrl, reconnectRequired: bool }
  Y    NUNCA recibo el refresh_token ni el access_token

Escenario: El usuario desconecta su cuenta
  Dado que tengo Jira conectado
  Cuando ejecuto la acción de desconectar
  Entonces el backend revoca el refresh_token contra Atlassian (best effort)
  Y    elimina el refresh_token, cloudId y siteUrl del registro del usuario
  Y    las DailyActivity con source='jira' previas SE CONSERVAN (auditoría)
  Y    futuros runs del cron NO intentan sincronizar Jira para este usuario

Escenario: El refresh_token deja de funcionar (token rotation falló o el user revocó desde Atlassian)
  Dado que el cron diario intenta refrescar mi access_token
  Cuando Atlassian responde 401/invalid_grant al refresh
  Entonces el backend marca `reconnectRequired = true` para mi usuario
  Y    NO se importan actividades Jira en ese run
  Y    el resto del informe (Google) se genera normalmente
  Y    el frontend puede mostrarme el aviso "Reconectá tu cuenta de Jira"
```

---

> **HU‑04 (admin) eliminada.** El admin no tiene flujo operativo en esta integración. Si en el futuro se necesita visibilidad agregada de actividad Jira por empresa, se documenta como feature separada en otro FRD.

---

## 5. Reglas de negocio

| ID    | Regla                                                                                          | Origen / Justificación |
| ----- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| RN-01 | El refresh token de Jira se persiste **siempre cifrado** (AES‑256‑GCM) y nunca sale del backend | Mismo modelo que `refreshToken` de Google (`shared/utils/crypto.js`). Decisión de seguridad heredada. |
| RN-02 | La sincronización es **batch diaria**, no en tiempo real                                       | Decisión arquitectónica del MVP (ADR-001 + C4). Atlassian webhooks queda como deseable post-MVP. |
| RN-03 | Solo se sincroniza actividad **del propio usuario** (`assignee = currentUser()` + acciones del usuario) | OAuth 3LO entrega un token con permisos del user — no hay impersonación. |
| RN-04 | La importación es **idempotente** por la clave lógica `(userId, issueKey, actionType, timestamp)` | F2B-04.5 — evita duplicados ante reintentos del cron. |
| RN-05 | Si el `refresh_token` falla, el resto del informe del día (Google) **debe completarse igual**  | Falla parcial no debe romper el informe completo (degradación graceful, NFR §8). |
| RN-06 | Un usuario tiene **una sola** conexión Jira activa a la vez                                   | Si el usuario tiene acceso a múltiples sites Atlassian, se persiste el `cloudId` del primero accesible (configurable). |
| RN-07 | Las `DailyActivity` con `source='jira'` previas a una desconexión **se conservan**            | Auditoría e histórico de informes ya aprobados (ver F4-04 — informes aprobados son inmutables). |
| RN-08 | Los scopes solicitados a Atlassian son los **mínimos** para leer issues, changelog y worklogs del usuario | Principio de menor privilegio. Sin permisos de escritura. |
| RN-09 | El flujo de conexión Jira **solo se inicia si el usuario ya existe** en la BD. No hay autocreación al loguear ni al recibir el callback OAuth | Los usuarios los crea su admin. Sin user → 404 explícito. |
| RN-10 | La operación de sync recibe del caller **`(userId, desde, hasta)`**. La integración no decide ventanas ni horarios, solo procesa la ventana que recibe | Desacopla el módulo Jira del orquestador / cron / configuración de jornada. Permite invocaciones manuales, programadas o de recovery sin cambios en el módulo. |
| RN-11 | Solo se importan acciones de Jira con timestamp **dentro** de la ventana `[desde, hasta]`. Acciones fuera de la ventana se descartan | Garantiza coherencia con la "jornada" que el caller decidió. |
| RN-12 | El foco de la integración son **los tickets en los que el usuario está trabajando** (asignados o donde tuvo actividad en la ventana). No se enriquece con custom fields ni se distingue ticket interno vs cliente | Decisión de cliente — el resumen IA solo necesita saber "qué tocó", no la metadata del proyecto. |
| RN-13 | Si el usuario tiene acceso a **múltiples sites Atlassian**, se toma el **primero accesible** devuelto por `accessible-resources`. La integración no orquesta múltiples sites por usuario | Foco en la actividad del usuario, no en gestión multi‑site. Si en el futuro hace falta, se documenta como feature aparte. |
| RN-14 | Cuando el admin **elimina un usuario**, las `DailyActivity` previas (incluyendo las de Jira) se **conservan**, pero las **credenciales Jira se eliminan** (refresh token, cloudId, siteUrl) | Auditoría histórica intacta + minimización de datos sensibles tras el evento de eliminación. La lógica de eliminación pertenece a la feature de gestión de usuarios; este FRD requiere que invoque a `disconnect()` (o equivalente) del módulo Jira como parte del flujo. |

---

## 6. Datos manejados (vista funcional)

| Concepto                              | Descripción                                                              | Sensibilidad   |
| ------------------------------------- | ------------------------------------------------------------------------ | -------------- |
| Refresh token Atlassian               | Permite obtener nuevos access tokens sin re‑autorización del usuario     | **secreta**    |
| `cloudId` del site Atlassian          | Identificador del site del usuario, necesario para construir URLs API    | interna        |
| `siteUrl` del workspace Atlassian     | URL legible del workspace (ej: `acme.atlassian.net`)                     | interna        |
| Email Atlassian del usuario           | Email asociado a la cuenta Jira, devuelto por `/me`                      | interna        |
| `DailyActivity` de Jira               | Acciones del día (issue trabajado, comentario, transición, worklog) — campos básicos del ticket en metadata: `issue_key`, `summary`, `status`, `project_key`, `action_type` | interna        |
| `reconnectRequired` flag              | Booleano que indica que la conexión está rota                            | interna        |
| `lastSyncAt`                          | Timestamp de la última sincronización exitosa                            | interna        |
| Ventana de tiempo `(desde, hasta)` (recibida, no almacenada) | Parámetros de entrada del sync. La integración no consulta la jornada del usuario — la ventana la decide el caller. | n/a            |

> Las **secretas** se cifran en reposo y nunca se loguean ni se exponen al frontend.
> El doc técnico define el cifrado y los exclusores de logs.

---

## 7. Integraciones externas (vista funcional)

| Sistema           | Para qué se usa                                              | Quién provee credenciales              | Disponibilidad de doc oficial |
| ----------------- | ------------------------------------------------------------ | -------------------------------------- | ----------------------------- |
| Atlassian Identity (`auth.atlassian.com`) | Flujo OAuth 2.0 (3LO): autorización + intercambio de tokens + refresh | Atlassian (app registrada por el equipo del proyecto) | **disponible** (developer.atlassian.com) |
| Jira Cloud REST API v3 (`api.atlassian.com/ex/jira/{cloudId}/...`) | Lectura de issues, changelog, comments y worklogs del día | n/a (vía OAuth)                       | **disponible** (REST API v3)  |

> Para el desarrollo se trabaja contra una cuenta personal de Atlassian Cloud (sandbox). Como cliente confirmó (ver §11): NO se filtra por `projectKey`, NO se necesitan custom fields, NO se distingue ticket interno vs cliente. Esto simplifica el mapper y elimina la dependencia de configuración tenant‑específica para el MVP.

---

## 8. Requerimientos no funcionales (perspectiva de negocio)

- **Performance:** la respuesta del endpoint `GET /api/jira/status` debe ser < 500 ms (consulta a DB, sin tocar Atlassian).
- **Disponibilidad / degradación:** si Atlassian no responde o el token está roto, el informe diario debe generarse igual con el resto de las fuentes (RN-05). El usuario ve "Reconectá tu cuenta" pero no se bloquea su flujo.
- **Tiempo de sync por usuario:** una invocación al sync con una ventana típica (jornada de 8‑10 hs) debe completarse en ≤ 60 segundos para usuarios con < 30 issues actualizados. Para usuarios con más actividad, escalar linealmente sin saturar rate limits de Atlassian.
- **Auditoría:** toda conexión, desconexión y reconexión queda en logs estructurados con `userId`, `event` y `timestamp`. Las `DailyActivity` importadas son trazables a su `issue_key` original.
- **Seguridad:** scopes mínimos, refresh tokens cifrados, `state` no predecible en el OAuth, ningún token expuesto al frontend.
- **Aislamiento entre usuarios (dentro del mismo deployment):** un usuario nunca puede ver / modificar la conexión Jira ni las `DailyActivity` de otro usuario. El aislamiento entre empresas distintas es trivial — viven en deployments separados, sin red ni BD compartidas.

---

## 9. Métricas de éxito

- [ ] **% de colaboradores con Jira conectado** dentro de los 7 días de habilitada la feature: objetivo ≥ 60% del equipo piloto.
- [ ] **# promedio de `DailyActivity` con `source='jira'` por usuario por día**: > 0 en días hábiles para usuarios con la conexión activa.
- [ ] **Tasa de fallos del sync diario** (runs que terminan con `reconnectRequired = true` o error no recuperable): < 5% del total.
- [ ] **Quejas de informes incompletos** después de aprobación: reducción medible vs línea base previa a Jira.

---

## 10. Supuestos y dependencias

| ID    | Supuesto / Dependencia                                                                 | Riesgo si es falso |
| ----- | -------------------------------------------------------------------------------------- | ------------------ |
| SU-01 | Se usará **OAuth 2.0 (3LO)** y NO API Token, contradiciendo lo que dice el C4 actual   | Bajo — el C4 se actualiza; ambos métodos son viables, OAuth da mejor UX (no requiere que el user genere un token a mano) |
| SU-02 | Cada colaborador autoriza a la app **individualmente** desde Atlassian                  | Bajo — Jira Cloud lo permite sin admin consent |
| SU-03 | Si el usuario tiene varios sites Atlassian, se toma el **primero accesible** — no orquestamos múltiples | Bajo — confirmado por cliente, foco en actividad del usuario (RN-13) |
| SU-04 | Los colaboradores del cliente que adopta cada deployment usan Jira **Cloud**, no Server / Data Center | Alto — si fuese Server/DC, este plan no aplica (auth y endpoints distintos). Validar con cada nuevo cliente al onboardear |
| SU-05 | La actividad relevante se obtiene combinando: issues asignados actualizados en el día + comments + worklogs + changelog (transitions) del usuario, **sin custom fields** | Bajo — confirmado por cliente |
| SU-06 | Existirá un **dev dedicado** a F2B en paralelo con F2 (ver Gantt) durante 2026‑05‑07 → 2026‑05‑25 | Alto — sin dedicación el plan se desliza dentro de la ruta crítica |
| SU-07 | Cada empresa que despliega la plataforma **registra su propia app OAuth en developer.atlassian.com** y configura `JIRA_CLIENT_ID`/`JIRA_CLIENT_SECRET` en su `.env` | Medio — si una empresa no lo hace, su instancia no puede usar Jira (error claro al boot por env var faltante) |
| SU-08 | El **CRUD de usuarios por admin existe** (feature separada) y los usuarios productivos vienen creados por su admin antes de usar Jira | Alto — sin esta feature, la integración no tiene "users válidos" sobre los que correr |
| SU-09 | Existe (o existirá) un **caller** del sync — orquestador / cron / endpoint manual — que decide cuándo invocarlo y con qué ventana. La integración no se preocupa por quién es | Bajo — el módulo Jira es invocable independientemente; la automatización end‑to‑end depende del caller pero no bloquea el desarrollo de Jira |
| DEP-01 | Depende de **F1-03** (helper `crypto.js`) — ya implementado y testeado                  | n/a — ya disponible |
| DEP-02 | Depende de **F0-05.5** (modelo `DailyActivity`) — ya implementado                      | n/a — ya disponible |
| DEP-03 | Depende de **F2-05.2** (función de merge para timeline consolidada) — pendiente F2     | Medio — si F2 se atrasa, F2B-05 se desliza pero F2B-04 puede avanzar |
| DEP-04 | Depende de la feature **"gestión de usuarios por admin"** (incluye bootstrap del admin con key) — y de que esa feature invoque a `disconnect()` del módulo Jira al eliminar un user (RN-14)   | Alto — bloquea adopción real (ver SU-08) y la correcta limpieza de credenciales |
| DEP-05 | Depende de un **caller del sync** (orquestador de cron alimentado por la jornada laboral del usuario, o endpoint manual). NO es bloqueante para desarrollar el módulo Jira | Bajo — el módulo Jira se puede testear y entregar invocando manualmente |

> Cuando se onboardee un nuevo cliente (Finegans u otro), **revisar primero** SU-04 antes de habilitarlo.

---

## 11. Preguntas abiertas

### Resueltas (rev. 2 — 2026‑05‑10)

- [x] **#1 (cliente) → RESUELTA:** no se filtra por `projectKey`. Se toma toda la actividad del usuario (RN-12). _Foco: en qué tickets está trabajando._
- [x] **#2 (cliente) → RESUELTA:** no se necesitan custom fields. Solo campos básicos del ticket: `issue_key`, `summary`, `status`, `project_key`, `action_type` (RN-12).
- [x] **#3 (cliente) → RESUELTA:** no se distingue ticket interno vs ticket de cliente.
- [x] **#4 (equipo) → RESUELTA:** si el usuario tiene varios sites, se toma el **primero accesible**. No se orquestan múltiples sites por usuario (RN-13).
- [x] **#5 (equipo) → RESUELTA:** no hay horario global del cron. **Cada usuario configura su jornada laboral**, y el orquestador dispara el sync al final de la jornada de cada usuario (RN-10, RN-11). La gestión del campo "jornada laboral" pertenece a otra feature (DEP-05).

### Resueltas (rev. 3 — 2026‑05‑10) tras decisión de modelo de distribución (self‑hosted)

- [x] **#6 (arquitectura) → RESUELTA:** no hay entidad `Company` ni `User.companyId`. La plataforma es **self‑hosted single‑tenant por deployment** — no hace falta modelar el tenant en BD.
- [x] **#7 (equipo) → RESUELTA:** no aplica — sin entidad `Company`, no hay restricción "1 admin por empresa" en BD. Cada deployment puede tener N admins (rol `ADMIN` en N usuarios). La regla operativa "habrá típicamente uno" es organizacional, no técnica.
- [x] **#10 (equipo) → RESUELTA:** la key de bootstrap se entrega junto con el código (configurable como `BOOTSTRAP_ADMIN_KEY` en el `.env` del deployment). La empresa la usa una vez para crear el primer admin; una vez consumida, el endpoint deja de funcionar. Detalle del formato exacto pertenece a la feature de bootstrap admin, no a este FRD.

### Resueltas (rev. 4 — 2026‑05‑10)

- [x] **#8 → RESUELTA:** al eliminar un user, **se preservan las `DailyActivity` previas** (incluidas las de Jira) y **se eliminan las credenciales Jira** (refresh token, cloudId, siteUrl). Codificado como **RN‑14**. La feature de gestión de usuarios debe invocar `disconnect()` (o equivalente) del módulo Jira como parte del flujo de eliminación.
- [x] **#9 → RESUELTA:** la jornada laboral es **configurable por día** y vive en otra feature. **No afecta a Jira.** El módulo Jira recibe del caller `(userId, desde, hasta)` y procesa esa ventana — no consulta jornadas, no decide horarios. Codificado como **RN‑10** y **RN‑11**.

### Abiertas

_Ninguna a la fecha. Si surgen durante la implementación, se agregan acá._

---

## 12. Checklist de cierre del documento

- [x] Cada HU tiene al menos un escenario "happy path" y uno de error
- [x] Cada criterio de aceptación es observable (status code, persistencia, log)
- [x] Out of scope está explicitado
- [x] Existe un doc técnico asociado (link en metadata) — **rev. técnico pendiente** tras estos cambios
- [x] Los supuestos están listados y son revisables cuando llegue la doc del cliente
- [x] Validado con cliente las preguntas #1 a #5 (rev. 2)
- [x] Resueltas #6, #7, #10 tras la decisión de self‑hosted (rev. 3)
- [x] Resueltas #8 y #9 (rev. 4) — sin preguntas abiertas
- [ ] Actualizar el doc técnico para reflejar: validación de user, **firma del sync `(userId, desde, hasta)`** en lugar de `(userId, date)`, eliminación de HU‑04, sin entidad `Company` en el modelo de datos, OAuth app de Atlassian per‑deployment, gancho `disconnect()` invocable desde la feature de eliminación de usuarios
