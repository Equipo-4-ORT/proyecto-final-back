# SPEC (Funcional) — &lt;Nombre de la feature&gt;

> Especificación **funcional** (estilo SDD — *Spec-Driven Development*). Describe **qué** debe hacer el sistema y **por qué**, no el cómo. El cómo (diseño, módulos, contratos) va en la spec técnica asociada y/o en un ADR.
>
> **Cómo usar este template:** copialo a `docs/specs/SPEC-<slug>.md`, completá cada `<…>`, borrá las notas en cursiva y las filas de ejemplo, y eliminá las secciones que de verdad no apliquen (dejá registrado *por qué* las quitaste). Lo que no esté resuelto NO se borra: va a §13 (Cuestiones abiertas).

| | |
|---|---|
| **Feature ID** | `<F#-##>` (ver MVP / backlog) |
| **Estado** | `Borrador` \| `En revisión` \| `Aprobada` \| `Implementada` |
| **Fecha** | `<YYYY-MM-DD>` |
| **Autor(es)** | `<nombre>` |
| **Spec técnica** | `<[SPEC-TEC-<slug>](./SPEC-TEC-<slug>.md) o "pendiente">` |
| **ADR relacionado** | `<[ADR-###](../adr/ADR-###-<slug>.md) o "ninguno">` |
| **Módulo destino** | `<src/modules/...>` |

---

## 1. Propósito

*Una a tres oraciones: qué problema de negocio resuelve esta feature y para quién. Sin detalles técnicos.*

`<...>`

## 2. Objetivos y No-objetivos

**Objetivos** *(lo que esta spec SÍ cubre — verificable)*
- `<...>`

**No-objetivos** *(fuera de alcance de ESTA spec — evita el scope creep; cada ítem dice por qué)*
- `<...>` — *porque `<motivo / dónde se resuelve>`*

## 3. Actores y permisos

| Actor / Rol | Descripción | Qué puede hacer en esta feature |
|---|---|---|
| `<EMPLOYEE>` | `<...>` | `<...>` |
| `<ADMIN>` | `<...>` | `<...>` |
| `<Sistema / batch>` | `<...>` | `<...>` |

> *Indicá explícitamente quién NO debe poder hacer cada acción (base de los criterios de seguridad de §9).*

## 4. Supuestos y dependencias

- **Decisiones ya tomadas:** `<...>`
- **Servicios / módulos existentes de los que depende:** `<...>`
- **Infraestructura o datos que faltan crear:** `<...>`
- **Supuestos sobre el entorno** (datos en BD ya válidos, integraciones conectadas, etc.): `<...>`

## 5. Casos de Uso

> *Uno por flujo relevante. El flujo principal es el camino feliz; los alternativos cubren desvíos y errores. Numerá los pasos para poder referenciarlos desde los criterios de aceptación.*

### CU-01 — `<Nombre del caso de uso>`
- **Actor:** `<...>`
- **Precondición:** `<estado del sistema antes de empezar>`
- **Disparador:** `<acción del usuario / evento / tick>`
- **Flujo principal:**
  1. `<...>`
  2. `<...>`
- **Postcondición:** `<estado del sistema al terminar OK>`
- **Flujos alternativos / excepciones:**
  - `1a.` `<desvío>` → `<comportamiento esperado>`

### CU-02 — `<...>`
*(repetir estructura)*

## 6. Reglas de Negocio

| ID | Regla |
|---|---|
| **RN-01** | `<regla invariante del dominio, redactada como afirmación verificable>` |
| **RN-02** | `<...>` |

## 7. Validaciones

| ID | Validación | Cuándo | Si falla |
|---|---|---|---|
| **V-01** | `<qué se valida, p. ej. formato/rango/unicidad de un input>` | `<al guardar / al iniciar / por request>` | `<error 4xx, fail-fast, degradar, omitir...>` |
| **V-02** | `<...>` | `<...>` | `<...>` |

> *Cubrí explícitamente: entradas obligatorias vs. opcionales, formatos, rangos, longitudes máximas, tipos, y qué pasa con valores ausentes/nulos.*

## 8. Casos borde

| ID | Caso | Comportamiento esperado |
|---|---|---|
| **E-01** | *Entrada vacía / nula / con solo espacios* | `<...>` |
| **E-02** | *Límites: valor mínimo, máximo, cero, negativos, listas vacías* | `<...>` |
| **E-03** | *Volumen / paginación / colección muy grande* | `<...>` |
| **E-04** | *Concurrencia: dos acciones simultáneas sobre el mismo recurso* | `<...>` |
| **E-05** | *Idempotencia / reintento: la misma operación ocurre dos veces* | `<...>` |
| **E-06** | *Dependencia externa caída / lenta / responde error* | `<...>` |
| **E-07** | *Cambio de estado a mitad del flujo (recurso borrado/modificado)* | `<...>` |
| **E-08** | *Zona horaria / DST / fechas que cruzan medianoche* (si aplica) | `<...>` |
| **E-09** | *Unicode / caracteres especiales / emojis en texto libre* | `<...>` |

> *Borrá los que no apliquen y agregá los propios del dominio. Cada caso borde debería tener un test.*

## 9. Criterios de Seguridad

| ID | Criterio | Detalle |
|---|---|---|
| **SEC-01** | **Autenticación** | `<quién debe estar logueado; qué pasa sin token / token vencido>` |
| **SEC-02** | **Autorización** | `<qué rol/owner puede; cómo se evita el acceso horizontal (ver datos de otro usuario) y vertical (escalar a admin)>` |
| **SEC-03** | **Validación y sanitización de input** | `<toda entrada se valida en el back (Zod); no confiar en el front; prevenir inyección / payloads malformados>` |
| **SEC-04** | **Datos sensibles** | `<qué datos son sensibles (tokens, PII); cifrado en reposo, no exponer en respuestas/logs/errores>` |
| **SEC-05** | **Mínima exposición** | `<la respuesta solo incluye los campos necesarios; sin filtrar IDs internos, stack traces ni datos de terceros>` |
| **SEC-06** | **Rate limiting / abuso** | `<endpoints sensibles limitados; protección contra fuerza bruta / enumeración>` |
| **SEC-07** | **Auditoría** | `<qué acciones se loguean (quién, qué, cuándo) sin volcar PII>` |
| **SEC-08** | **Secretos y config** | `<credenciales por env, nunca en repo ni en el cuerpo de respuestas>` |

> *Pensá como atacante: ¿qué pasa si mando el `id` de otro usuario? ¿si omito el token? ¿si mando 10MB de JSON? ¿si llamo el endpoint 1000 veces/seg?*

## 10. Requisitos No Funcionales

| ID | Requisito |
|---|---|
| **RNF-01** | *Rendimiento:* `<tiempos de respuesta esperados, volumen soportado>` |
| **RNF-02** | *Observabilidad:* `<logs/eventos estructurados; sin PII>` |
| **RNF-03** | *Disponibilidad / resiliencia:* `<degradación esperada ante fallos>` |
| **RNF-04** | *Configurabilidad:* `<qué se controla por env>` |
| **RNF-05** | *Accesibilidad / i18n:* `<si aplica>` |

## 11. Scope de cambio

> *Acotá el blast radius. Qué se toca y qué NO. Sirve para el reviewer y para estimar.*

**Se modifica / crea:**
- `<módulo / endpoint / tabla / archivo>` — `<qué cambio>`

**Se deja intacto (y por qué):**
- `<...>`

**Impacto en otros consumidores / contratos:**
- `<¿rompe el front? ¿migración de datos? ¿breaking change de API?>`

## 12. Criterios de Aceptación

> *Formato Dado / Cuando / Entonces. Cada criterio referencia su CU/RN y debe ser verificable con un test.*

- **CA-01 (CU-01, RN-01):** *Dado* `<...>`, *cuando* `<...>`, *entonces* `<...>`.
- **CA-02 (SEC-02):** *Dado* un usuario que pide un recurso ajeno, *cuando* `<...>`, *entonces* recibe `403/404` y no se filtran datos.
- **CA-03 (E-0x):** *Dado* `<caso borde>`, *cuando* `<...>`, *entonces* `<...>`.

## 13. Cuestiones abiertas

> *Preguntas sin resolver que bloquean o condicionan la implementación. NO las borres: marcalas resueltas cuando se decidan y movelas a §14.*

1. **`<tema>`** — `<la pregunta concreta>`. *Bloquea:* `<sí/no — qué>`. *Responsable de decidir:* `<quién>`.
2. `<...>`

## 14. Cuestiones resueltas

> *Histórico de decisiones, para no re-discutir. Migrá acá lo cerrado de §13.*

1. **`<tema>`:** `<decisión tomada>` — *`<fecha / quién>`*.

## 15. Fuera de alcance

- `<feature relacionada que NO se hace ahora; dónde/cuándo se haría>`

## 16. Referencias

- `<MVP, tickets, ADRs, docs de APIs externas, mockups>`
