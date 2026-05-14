# Requerimientos Funcionales — `<Nombre del módulo / feature>`

> Template para documentar **qué** hace el módulo desde la perspectiva del negocio y del usuario.
> No incluye decisiones de implementación (eso va en `technical-requirements.template.md`).

---

## 0. Metadata

| Campo            | Valor                                       |
| ---------------- | ------------------------------------------- |
| Módulo           | `<auth \| google \| jira \| reports \| …>`  |
| Feature / Épica  | `<nombre>`                                  |
| Autor(es)        | `<nombre>`                                  |
| Estado           | `Draft \| In Review \| Approved \| Frozen`  |
| Fecha creación   | `YYYY-MM-DD`                                |
| Última revisión  | `YYYY-MM-DD`                                |
| Issue / Ticket   | `<link>`                                    |
| Documento técnico relacionado | `docs/<feature>/technical-requirements.md` |

---

## 1. Contexto y motivación

> Por qué existe esta feature. Qué problema de negocio resuelve.
> Una a tres oraciones — sin diseño técnico, sin endpoints.

- **Problema:** …
- **Origen del requerimiento:** `<cliente Finegans \| equipo \| compliance \| …>`
- **Impacto si no se hace:** …

---

## 2. Stakeholders y usuarios

| Rol                  | Quién es                            | Qué espera de la feature |
| -------------------- | ----------------------------------- | ------------------------ |
| Empleado (`EMPLOYEE`) | Usuario final                       | …                        |
| Administrador (`ADMIN`) | Responsable de configurar/auditar | …                        |
| Sistema externo      | `<Jira \| Google \| IA \| …>`       | …                        |

> Mantener consistencia con el `enum Role` definido en `prisma/schema.prisma`.

---

## 3. Alcance

### 3.1. In scope

- [ ] …
- [ ] …

### 3.2. Out of scope (explícito)

- [ ] …
- [ ] …

> Documentar lo que NO se hace evita ambigüedad y arrastre de scope en el PR.

---

## 4. Historias de usuario

> Una historia por cada flujo independiente. Usar el formato estándar.

### HU-01 — `<título>`

**Como** `<rol>`
**quiero** `<acción / capacidad>`
**para** `<beneficio / valor>`.

#### Criterios de aceptación

> Formato Gherkin (Given / When / Then). Estos van a mapear 1‑a‑1 con tests
> en `tests/modules/<modulo>/`.

```gherkin
Escenario: <camino feliz>
  Dado <precondición>
  Y    <precondición>
  Cuando <acción del usuario / sistema>
  Entonces <resultado observable>
  Y    <efecto lateral verificable, ej: registro persistido, log emitido>

Escenario: <camino de error>
  Dado <precondición>
  Cuando <acción inválida>
  Entonces <error tipificado y código HTTP esperado>
  Y    el sistema NO debe <efecto colateral indeseado>
```

> Reglas para los criterios:
> - Cada escenario debe ser **observable** (status code, payload, registro en DB, log estructurado).
> - "Errores controlados" deben mencionar el shape devuelto por `errorHandler` (`shared/middleware/errorHandler.js`).
> - Si el escenario depende de un servicio externo (Jira, Google, IA), aclarar el **modo de fallo esperado** (timeout, 401, 5xx).

### HU-02 — …

---

## 5. Reglas de negocio

> Restricciones invariantes que la feature debe respetar, independientes del flujo.

| ID    | Regla                                                                         | Origen / Justificación |
| ----- | ----------------------------------------------------------------------------- | ---------------------- |
| RN-01 | Email del usuario se normaliza a lowercase + trim antes de persistir          | Postgres `unique` es case‑sensitive (ver `users.service.js`) |
| RN-02 | Solo usuarios con rol `ADMIN` pueden …                                        | …                      |
| RN-03 | …                                                                             | …                      |

---

## 6. Datos manejados (vista funcional)

> Qué información maneja la feature. **No** schema SQL — eso va en el doc técnico.

| Concepto      | Descripción                       | Sensibilidad         |
| ------------- | --------------------------------- | -------------------- |
| `<entidad>`   | …                                 | `pública \| interna \| confidencial \| secreta` |
| `<entidad>`   | …                                 | …                    |

> "Secreta" implica que el doc técnico debe definir cifrado en reposo
> (`shared/utils/crypto.js` — AES‑256‑GCM) y manejo de logs (no loguear el valor).

---

## 7. Integraciones externas (vista funcional)

| Sistema | Para qué se usa | Quién provee credenciales | Disponibilidad de doc oficial |
| ------- | --------------- | ------------------------- | ----------------------------- |
| `<Jira / Google / …>` | … | `<Finegans \| equipo>`    | `<sí \| pendiente>`           |

> Si la doc oficial está pendiente, listar acá los **supuestos** que se tomaron
> para avanzar y que deberán validarse cuando llegue (ver §10).

---

## 8. Requerimientos no funcionales (perspectiva de negocio)

> Solo la expectativa funcional. El cómo se cumple va en el doc técnico.

- **Performance:** `<ej: el usuario debe ver el reporte en < 3 s>`
- **Disponibilidad:** `<ej: la feature degrada gracefully si Jira no responde>`
- **Auditoría:** `<ej: toda creación/edición debe quedar registrada con userId>`
- **Accesibilidad / i18n:** `<si aplica>`

---

## 9. Métricas de éxito

> Cómo sabemos que esta feature funciona en producción.

- [ ] `<KPI 1 — ej: % de reportes generados sin intervención manual>`
- [ ] `<KPI 2>`

---

## 10. Supuestos y dependencias

| ID   | Supuesto / Dependencia                                                         | Riesgo si es falso |
| ---- | ------------------------------------------------------------------------------ | ------------------ |
| SU-01 | `<ej: Finegans usará el flujo estándar de OAuth de Atlassian Cloud>`          | …                  |
| SU-02 | `<ej: el campo "estimación" en Jira existe como custom field cf[10016]>`      | …                  |

> Cuando llegue la doc oficial de Finegans, este bloque es lo primero que hay
> que revisar antes de mergear a `main`.

---

## 11. Preguntas abiertas

- [ ] `<#1>` — bloqueante para …
- [ ] `<#2>`

---

## 12. Checklist de cierre del documento

- [ ] Cada HU tiene al menos un escenario "happy path" y uno de error
- [ ] Cada criterio de aceptación es observable (no usa "debería funcionar bien")
- [ ] Out of scope está explicitado
- [ ] Existe un doc técnico asociado (link en metadata)
- [ ] Los supuestos están listados y son revisables cuando llegue la doc del cliente
