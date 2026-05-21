const prisma = require('../src/shared/database/prisma');

async function main() {
  console.log('🌱 Iniciando el proceso de seeding...');

  // Hacemos todo el flujo dentro de una transacción para que sea atómico
  await prisma.$transaction(async (tx) => {
    // 1. Limpiar la base de datos (Evita duplicados si corres el seed varias veces)
    await tx.report.deleteMany();
    await tx.dailyActivity.deleteMany();
    await tx.user.deleteMany();

    // 2. Crear un usuario de prueba (Empleado de Finnegans)
    const user = await tx.user.create({
      data: {
        email: 'jperez@finnegans.com.ar',
        fullName: 'Juan Pérez',
        role: 'EMPLOYEE',
        googleId: 'google-oauth-mock-id-123',
      },
    });

    console.log(`👤 Usuario creado: ${user.fullName}`);

    // 3. Crear actividades diarias simuladas (Huella digital del Viernes 24 de Abril de 2026)
    // Usamos el formato ISO-8601 para las fechas (UTC)
    await tx.dailyActivity.createMany({
      data: [
        {
          userId: user.id,
          source: 'calendar',
          activityType: 'meeting',
          startTime: new Date('2026-04-24T13:00:00Z'), // 10:00 AM hora local (UTC-3)
          endTime: new Date('2026-04-24T14:00:00Z'), // 11:00 AM hora local
          metadata: {
            summary: 'Reunión de Sincronización de Equipo',
            link: 'https://meet.google.com/abc-defg-hij',
            attendees: 5,
          },
        },
        {
          userId: user.id,
          source: 'drive',
          activityType: 'edit',
          startTime: new Date('2026-04-24T14:30:00Z'), // 11:30 AM hora local
          endTime: new Date('2026-04-24T16:00:00Z'), // 13:00 PM hora local
          metadata: {
            documentName: 'Especificaciones Técnicas AutoLog.docx',
            documentId: 'doc-mock-id-456',
            action: 'edited',
          },
        },
        {
          userId: user.id,
          source: 'calendar',
          activityType: 'focus_time',
          startTime: new Date('2026-04-24T18:00:00Z'), // 15:00 PM hora local
          endTime: new Date('2026-04-24T20:00:00Z'), // 17:00 PM hora local
          metadata: {
            summary: 'Bloqueo de Calendario: Desarrollo Backend',
          },
        },
      ],
    });

    console.log('📅 Actividades de Calendar y Drive registradas.');

    // 4. Crear un reporte preliminar generado por la IA (Timesheet)
    await tx.report.create({
      data: {
        userId: user.id,
        reportDate: new Date('2026-04-24T00:00:00Z'), // El reporte pertenece al viernes
        status: 'PENDING', // Listo para que el usuario lo revise el lunes
      },
    });

    console.log('📝 Reporte automático creado y en estado pendiente.');
  });

  console.log('✅ Seeding completado con éxito.');
}

main()
  .catch((e) => {
    console.error('❌ Error durante el seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
