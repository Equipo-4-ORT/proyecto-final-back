# ADR-002: Arquitectura de Monolito Modular

- **Estado:** Aceptado
- **Fecha:** 2026-05-04

---

## Contexto

Es una aplicación de gestión empresarial desarrollada como proyecto final de carrera. El equipo es pequeño (menos de 5 desarrolladores), el tiempo de entrega es acotado y el foco está en la correcta implementación de funcionalidades más que en la escalabilidad operacional.

Fue necesario elegir un estilo arquitectónico para el backend que balanceara velocidad de desarrollo, mantenibilidad y simplicidad de despliegue.

Las opciones evaluadas fueron:

1. **Monolito tradicional** — todo el código en un único módulo sin separación interna.
2. **Monolito modular** — un único proceso desplegable dividido en módulos cohesivos e independientes internamente.
3. **Microservicios** — cada dominio de negocio como un servicio independiente con su propia base de datos y despliegue.
4. **Serverless** — funciones stateless desplegadas en la nube que se ejecutan bajo demanda.

---

## Decisión

Se adopta la arquitectura de **monolito modular**.

El backend corre como un único proceso Node.js/Express, pero el código está organizado en módulos por dominio (auth, empleados, reuniones, etc.), cada uno con su propia carpeta de rutas, controladores, servicios y repositorio.

---

## Justificación

| Criterio | Detalle |
|---|---|
| Velocidad de desarrollo | Alta — un único repositorio y proceso simplifican la iteración |
| Complejidad operacional | Baja — un solo artefacto para construir, desplegar y monitorear |
| Separación de responsabilidades | Clara — cada dominio tiene su propia carpeta de rutas, controladores, servicios y repositorio |
| Escalabilidad | Media — escala verticalmente o replicando el proceso completo |
| Adecuado para equipos pequeños | Sí — permite trabajo paralelo por módulo sin fricción de coordinación entre servicios |
| Costo de infraestructura | Bajo — un único servidor o contenedor es suficiente para el alcance del proyecto |

Los microservicios fueron descartados porque requieren infraestructura adicional (API Gateway, service discovery, comunicación inter-servicios, múltiples bases de datos) que agrega overhead significativo sin aportar beneficios reales al tamaño y alcance del proyecto.

El serverless fue descartado porque introduce latencia por cold starts, dificulta el debugging local y complica el manejo de estado de sesiones OAuth.

El monolito tradicional fue descartado porque no ofrece separación de responsabilidades, lo que dificulta el trabajo en equipo y el mantenimiento a medida que el proyecto crece.

El monolito modular ofrece el mejor balance: permite que cada integrante del equipo trabaje en su módulo de forma independiente, facilita el testing por dominio y mantiene un único punto de despliegue simple.

---

## Consecuencias

**Positivas:**
- Un solo `docker-compose up` levanta todo el sistema.
- Cada módulo puede desarrollarse y testearse de forma aislada.
- Bajo costo de infraestructura y configuración.
- Curva de aprendizaje mínima para el equipo.

**Negativas:**
- Si en el futuro el sistema requiere escalar un módulo específico de forma independiente, se necesitaría una migración hacia microservicios.
- Un error no controlado en un módulo puede afectar el proceso completo.

**Mitigaciones:**
- Se implementa manejo global de errores para aislar fallos.
- La separación modular facilita una eventual extracción a microservicios si fuera necesario.
