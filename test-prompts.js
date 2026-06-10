// test-prompts.js
require('dotenv').config();
// Asegurate de que esta ruta apunte correctamente a tu adapter
const GeminiAdapter = require('./src/modules/ai/adapters/gemini.adapter'); 

// Simulamos el objeto userContext que enviaría el servicio
const mockUserContext = { 
    name: "Felipe Valenzuela", 
    role: "Full-Stack Developer", 
    date: "2026-06-10" 
};

// --- ESCENARIOS DE PRUEBA (Simulando lo que devolvería Prisma) ---

// ESCENARIO A: Día de Código (Bloques largos y concentrados)
const escenarioA = [
    { 
        source: "jira", app: "Jira", activityType: "transition", 
        metadata: { title: "PFK-22: Configurar Prisma" }, 
        startTime: new Date("2026-06-10T09:00:00Z"), endTime: new Date("2026-06-10T11:00:00Z"), duration: 120 
    },
    { 
        source: "drive", app: "Docs", activityType: "read", 
        metadata: { title: "Especificaciones AutoLog API.docx" }, 
        startTime: new Date("2026-06-10T11:00:00Z"), endTime: new Date("2026-06-10T12:00:00Z"), duration: 60 
    },
    { 
        source: "jira", app: "Jira", activityType: "transition", 
        metadata: { title: "PFK-24: Endpoint Generar Reporte" }, 
        startTime: new Date("2026-06-10T13:00:00Z"), endTime: new Date("2026-06-10T15:00:00Z"), duration: 120 
    }
];

// ESCENARIO B: Día de Reuniones (Con horarios solapados para probar suma de horas)
const escenarioB = [
    { 
        source: "calendar", app: "Meet", activityType: "meeting", 
        metadata: { title: "Daily Sync Equipo 4" }, 
        startTime: new Date("2026-06-10T10:00:00Z"), endTime: new Date("2026-06-10T11:00:00Z"), duration: 60 
    },
    { 
        source: "calendar", app: "Meet", activityType: "meeting", 
        metadata: { title: "Revisión integración Finnegans" }, 
        startTime: new Date("2026-06-10T11:00:00Z"), endTime: new Date("2026-06-10T12:30:00Z"), duration: 90 
    },
    // Se solapa con la reunión anterior:
    { 
        source: "drive", app: "Docs", activityType: "edit", 
        metadata: { title: "Manual Finnegans.pdf" }, 
        startTime: new Date("2026-06-10T12:15:00Z"), endTime: new Date("2026-06-10T12:45:00Z"), duration: 30 
    }
];

// ESCENARIO C: Día Caótico (Micro-tareas para probar agrupación)
const escenarioC = [
    { 
        source: "drive", app: "Docs", activityType: "edit", 
        metadata: { title: "Resumen_OAuth.docx" }, 
        startTime: new Date("2026-06-10T09:00:00Z"), endTime: new Date("2026-06-10T09:05:00Z"), duration: 5 
    },
    { 
        source: "drive", app: "Docs", activityType: "edit", 
        metadata: { title: "Resumen_OAuth.docx" }, 
        startTime: new Date("2026-06-10T09:10:00Z"), endTime: new Date("2026-06-10T09:15:00Z"), duration: 5 
    },
    { 
        source: "drive", app: "Docs", activityType: "edit", 
        metadata: { title: "Resumen_OAuth.docx" }, 
        startTime: new Date("2026-06-10T09:40:00Z"), endTime: new Date("2026-06-10T09:45:00Z"), duration: 5 
    },
    { 
        source: "calendar", app: "Meet", activityType: "meeting", 
        metadata: { title: "Sync rápida seguridad backend" }, 
        startTime: new Date("2026-06-10T10:00:00Z"), endTime: new Date("2026-06-10T10:30:00Z"), duration: 30 
    }
];

// --- MOTOR DE EJECUCIÓN ---

async function runTests() {
    console.log("🚀 Iniciando pruebas de Prompt Engineering...\n");
    
    // Instanciamos tu adapter real
    const adapter = new GeminiAdapter();

    try {
        console.log("=== TEST ESCENARIO A (Día de Código) ===");
        const resultA = await adapter.generateSummary(escenarioA, mockUserContext);
        console.log(JSON.stringify(resultA, null, 2));
        console.log("\n--------------------------------------------------\n");
        
        console.log("=== TEST ESCENARIO B (Reuniones / Solapamiento) ===");
        const resultB = await adapter.generateSummary(escenarioB, mockUserContext);
        console.log(JSON.stringify(resultB, null, 2));
        console.log("\n--------------------------------------------------\n");

        console.log("=== TEST ESCENARIO C (Micro-tareas) ===");
        const resultC = await adapter.generateSummary(escenarioC, mockUserContext);
        console.log(JSON.stringify(resultC, null, 2));
        console.log("\n==================================================\n");

        console.log("✅ Pruebas finalizadas. Analizá los JSON resultantes.");

    } catch (error) {
        console.error("❌ Error en la prueba:", error.message);
    }
}

runTests();