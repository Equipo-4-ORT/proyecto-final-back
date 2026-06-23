# SPEC-TEC (Técnica) — &lt;Nombre de la feature&gt;

> Especificación **técnica**. Describe **cómo** se implementa lo que define la spec funcional asociada: diseño, contratos, datos, errores y plan de cambio. Si una decisión es estructural y de largo plazo, va en un **ADR**; acá se referencia.
>
> **Cómo usar este template:** copialo a `docs/specs/SPEC-TEC-<slug>.md`, completá cada `<…>`, borrá las notas en cursiva y las filas de ejemplo. Toda decisión sin cerrar va a §12 (Cuestiones abiertas), no se omite.

| | |
|---|---|
| **Feature ID** | `<F#-##>` |
| **Estado** | `Borrador` \| `En revisión` \| `Aprobada` \| `Implementada` |
| **Fecha** | `<YYYY-MM-DD>` |
| **Autor(es)** | `<nombre>` |
| **Spec funcional** | `<[SPEC-<slug>](./SPEC-<slug>.md)>` |
| **ADR relacionado** | `<[ADR-###](../adr/ADR-###-<slug>.md) o "ninguno">` |
| **Módulo destino** | `<src/modules/...>` |
| **Stack relevante** | `<Express 5, Prisma, Zod, JWT, googleapis, node-cron, nodemailer, ...>` |

---

## 1. Resumen técnico

*Una a tres oraciones: el enfoque de implementación en una frase, y por qué este y no otro.*

`<...>`

## 2. Contexto y restricciones

- **Arquitectura vigente:** `<monolito modular, capas controller → service → repository, ver ADR-002>`
- **Restricciones técnicas:** `<una sola instancia, self-hosted, sin Redis, Node >=20, etc.>`
- **Convenciones del repo a respetar:** `<estructura de módulo, DTOs con Zod, manejo de errores centralizado, logger Winston, naming>`
- **Lo que NO se puede romper:** `<contratos de API consumidos por el front, esquema de BD existente, etc.>`

## 3. Diseño de la solución

*Descripción del enfoque. Diagrama de flujo/secuencia si ayuda (ASCII o link). Componentes nuevos y cómo interactúan con los existentes.*

```
<diagrama de flujo / secuencia / componentes>
```

**Componentes:**
| Componente | Responsabilidad | Nuevo / Modificado |
|---|---|---|
| `<...controller.js>` | `<valida request, delega, mapea respuesta>` | `<Nuevo>` |
| `<...service.js>` | `<lógica de negocio>` | `<...>` |
| `<...repository.js>` | `<acceso a datos>` | `<...>` |

## 4. Contrato de API

> *Un bloque por endpoint. Omitir esta sección si la feature no expone HTTP (p. ej. batch/cron).*

### `<MÉTODO> <ruta>`
- **Auth:** `<requiere JWT / rol mínimo / público>`
- **Rate limit:** `<límite aplicado o "ninguno">`
- **Path / query params:** `<nombre: tipo — descripción — obligatorio?>`
- **Request body** (Zod):
```json
{ "<campo>": "<tipo / constraint>" }
```
- **Respuestas:**

| Código | Cuándo | Body |
|---|---|---|
| `200/201` | `<éxito>` | `<shape de respuesta — solo campos necesarios>` |
| `400` | `<validación falla>` | `<formato de error estándar>` |
| `401` | `<sin auth / token inválido>` | `<...>` |
| `403` | `<sin permiso>` | `<...>` |
| `404` | `<no existe / no es del owner>` | `<...>` |
| `409` | `<conflicto / idempotencia>` | `<...>` |
| `429` | `<rate limit>` | `<...>` |
| `5xx` | `<error interno / dependencia caída>` | `<mensaje genérico, sin stack trace>` |

## 5. Modelo de datos

- **Tablas/modelos afectados (Prisma):** `<...>`
- **Cambios de esquema:** `<campos nuevos, tipos, nullability, defaults>`
- **Índices / constraints:** `<unique compuesto, índices para queries calientes>`
- **Migración:** `<reversible? requiere backfill? bloquea escritura? estrategia>`
- **Idempotencia / unicidad:** `<clave natural que evita duplicados, p. ej. userId+source+externalId>`

```prisma
<fragmento del modelo nuevo/modificado>
```

## 6. Dependencias externas e integraciones

| Dependencia | Uso | Modo de fallo | Manejo |
|---|---|---|---|
| `<Google API / SMTP / IA / Jira>` | `<...>` | `<timeout / 5xx / 401 / rate limit>` | `<reintento, degradar, marcar reconnect, circuit breaker>` |

- **Timeouts y reintentos:** `<valores; política de backoff>`
- **Rate limits / cuotas:** `<cómo se respetan>`
- **Idempotencia ante reintentos del lado externo:** `<...>`

## 7. Manejo de errores y estados de fallo

| Escenario | Detección | Respuesta al cliente | Log / efecto |
|---|---|---|---|
| `<validación de input>` | `<Zod>` | `400` | `<...>` |
| `<recurso no encontrado / ajeno>` | `<...>` | `404` | `<...>` |
| `<dependencia externa caída>` | `<...>` | `<degradar / 503>` | `<...>` |
| `<excepción no controlada>` | `<error handler global>` | `<500 genérico>` | `<log con stack, sin PII al cliente>` |

> *Regla: el cliente nunca recibe stack traces, mensajes de BD ni detalles internos.*

## 8. Consideraciones de seguridad

| ID | Control | Implementación |
|---|---|---|
| **SEC-01** | **AuthN** | `<middleware JWT; validación de expiración/firma>` |
| **SEC-02** | **AuthZ (horizontal y vertical)** | `<chequeo de ownership en service/repo: el recurso pertenece al `userId` del token; chequeo de rol>` |
| **SEC-03** | **Validación de input** | `<DTO Zod en el borde; whitelist de campos; límites de tamaño de body>` |
| **SEC-04** | **Inyección** | `<Prisma parametrizado; sin SQL crudo / interpolación; sanitización de salida si hay render>` |
| **SEC-05** | **Secretos y tokens** | `<cifrado en reposo; por env; nunca en respuestas/logs/repo>` |
| **SEC-06** | **Datos sensibles en tránsito y logs** | `<solo `userId` en logs; sin PII; HTTPS asumido en infra>` |
| **SEC-07** | **Rate limiting / anti-abuso** | `<express-rate-limit en endpoints sensibles; anti-enumeración>` |
| **SEC-08** | **Dependencias** | `<sin libs con CVEs conocidos; lockfile; revisión de nuevas deps>` |
| **SEC-09** | **Manejo de errores seguro** | `<sin stack traces al cliente; sin diferencia de timing/mensaje que permita enumerar>` |

> *Checklist mental de atacante: IDOR (acceso a recurso ajeno por id), escalada de privilegios, payload gigante, valores inesperados/nulos, inyección, fuga de datos en errores, fuerza bruta.*

## 9. Casos borde técnicos

| ID | Caso | Manejo técnico |
|---|---|---|
| **ET-01** | *Concurrencia / race condition sobre el mismo recurso* | `<transacción, lock optimista, unique constraint>` |
| **ET-02** | *Reintento / doble submit (idempotencia)* | `<clave idempotente, upsert, skipDuplicates>` |
| **ET-03** | *Payload grande / colección enorme* | `<paginación, límite de body, streaming>` |
| **ET-04** | *Valores límite (0, negativos, vacío, máximo)* | `<...>` |
| **ET-05** | *Dependencia externa lenta o caída* | `<timeout, degradar, no bloquear el resto>` |
| **ET-06** | *Fecha/zona horaria/DST/cruce de medianoche* | `<luxon, manejo UTC, tz explícita>` |
| **ET-07** | *Proceso reiniciado a mitad de operación* | `<recuperación, idempotencia, sin estado corrupto>` |
| **ET-08** | *Datos preexistentes inconsistentes / migración parcial* | `<...>` |

> *Borrá los que no apliquen; agregá los del dominio. Cada uno debería tener un test.*

## 10. Scope de cambio

> *Inventario preciso de archivos/áreas tocadas. Acota el blast radius para el reviewer.*

**Archivos / módulos nuevos:**
- `<src/modules/.../*.js>`

**Modificados:**
- `<archivo>` — `<qué cambia y por qué>`

**Esquema / migraciones:**
- `<prisma/schema.prisma, migración nueva>`

**Configuración / env nuevas:**
- `<VAR_NUEVA — descripción — default — obligatoria?>` (actualizar `.env.example`)

**NO se toca (y por qué):**
- `<...>`

**Breaking changes / coordinación con el front:**
- `<...>`

## 11. Plan de testing

| Tipo | Qué cubre | Casos clave |
|---|---|---|
| **Unitario** | `<services, validaciones, reglas de negocio>` | `<CA-01, RN-0x, ET-0x>` |
| **Integración** | `<controller + service + BD (supertest)>` | `<flujos felices + 401/403/404>` |
| **Seguridad** | `<AuthZ horizontal/vertical, input malicioso>` | `<SEC-02, SEC-03>` |
| **Casos borde** | `<§9>` | `<ET-0x>` |

- **Cobertura objetivo:** `<respetar threshold del repo: 80% lines/branches/functions/statements>`
- **Datos / mocks:** `<fixtures, __mocks__, seed>`

## 12. Cuestiones abiertas

> *Decisiones técnicas sin cerrar. No se borran: se migran a §13 al resolverse.*

1. **`<tema>`** — `<la pregunta>`. *Opciones:* `<A / B>`. *Trade-off:* `<...>`. *Bloquea implementación:* `<sí/no>`.
2. `<...>`

## 13. Decisiones técnicas tomadas

1. **`<tema>`:** `<decisión>` — *motivo:* `<...>` — *`<fecha / quién>`*.

## 14. Riesgos y mitigaciones

| Riesgo | Impacto | Probabilidad | Mitigación |
|---|---|---|---|
| `<...>` | `<alto/medio/bajo>` | `<...>` | `<...>` |

## 15. Plan de rollout y rollback

- **Despliegue:** `<orden: migración → deploy back → deploy front; feature flag?>`
- **Backfill / migración de datos:** `<si aplica>`
- **Rollback:** `<cómo se revierte; la migración es reversible?>`
- **Observabilidad post-deploy:** `<qué métricas/logs mirar para confirmar que anda>`

## 16. Referencias

- `<spec funcional, ADRs, docs de APIs, PRs relacionados>`
