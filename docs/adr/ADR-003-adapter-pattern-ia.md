# ADR-003: Adapter Pattern para la Integración de IA

- **Estado:** Aceptado
- **Fecha:** 2026-05-04
- **Autores:** Equipo Finnegans

---

## Contexto

Finnegans integra capacidades de inteligencia artificial para asistir en funcionalidades como generación de resúmenes, sugerencias y automatizaciones. El mercado de proveedores de IA (OpenAI, Google Gemini, Anthropic Claude, etc.) es altamente dinámico: los precios cambian, los modelos se deprecan y pueden surgir mejores alternativas.

Fue necesario definir cómo integrar el proveedor de IA elegido de forma que el resto del sistema no quede acoplado a una implementación específica.

Las opciones evaluadas fueron:

1. **Llamadas directas al SDK** — cada módulo que necesite IA importa y usa el SDK del proveedor directamente.
2. **Adapter Pattern** — una interfaz común que abstrae el proveedor; cada proveedor tiene su propio adaptador que implementa esa interfaz.
3. **Strategy Pattern** — similar al adapter pero orientado a intercambiar algoritmos en runtime.
4. **Servicio centralizado externo** — un microservicio separado que encapsula toda la lógica de IA.

---

## Decisión

Se adopta el **Adapter Pattern** para integrar el proveedor de IA.

Se define una interfaz `IAAdapter` con los métodos necesarios (por ejemplo `generateText`, `summarize`). Cada proveedor tiene su propio archivo adaptador que implementa esa interfaz y traduce las llamadas al SDK específico. El resto del sistema solo interactúa con la interfaz, sin saber qué proveedor hay detrás.

```
src/
└── adapters/
    └── ia/
        ├── IAAdapter.js          ← interfaz / contrato
        ├── openai.adapter.js     ← implementación OpenAI
        └── gemini.adapter.js     ← implementación Gemini
```

---

## Justificación

**Llamadas directas al SDK** fueron descartadas porque acoplan cada módulo a un proveedor específico. Si se cambia de OpenAI a Gemini, hay que modificar código en múltiples lugares del sistema, con alto riesgo de errores y sin centralización de la lógica.

**Strategy Pattern** fue considerado pero resulta más adecuado cuando el algoritmo cambia en runtime según una condición. En este caso el proveedor se configura por variable de entorno y no cambia durante la ejecución, por lo que el Adapter es más semántico y directo.

**Servicio externo** fue descartado por el mismo razonamiento del ADR-002: agrega overhead operacional innecesario para el tamaño del proyecto.

El **Adapter Pattern** es la opción óptima porque:

- **Desacoplamiento total:** los módulos de negocio no conocen el SDK del proveedor.
- **Intercambiabilidad:** cambiar de proveedor implica solo modificar una variable de entorno (`IA_PROVIDER=gemini`) y tener el adaptador implementado.
- **Testabilidad:** se puede mockear la interfaz sin depender de llamadas reales a la API.
- **Principio de responsabilidad única:** la traducción entre la interfaz interna y la API externa queda concentrada en un único archivo por proveedor.

---

## Consecuencias

**Positivas:**
- El sistema es agnóstico al proveedor de IA.
- Agregar un nuevo proveedor requiere solo crear un nuevo archivo adaptador sin tocar el resto del código.
- Facilita el testing unitario mediante mocks de la interfaz.
- Permite evaluar y comparar proveedores sin refactorizaciones costosas.

**Negativas:**
- Requiere definir y mantener la interfaz `IAAdapter` a medida que se agregan funcionalidades.
- Agrega una capa de indirección que puede resultar innecesaria si el sistema nunca cambia de proveedor.

**Mitigaciones:**
- La interfaz se documenta y versiona junto con el código.
- El costo de mantener la interfaz es significativamente menor al costo de un cambio de proveedor sin abstracción.
