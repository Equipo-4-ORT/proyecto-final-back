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
    // Nota: Como agregaste los @default en el schema (Ticket 5.3.5), 
    // este usuario ya nace con la jornada de 09:00 a 18:00 automáticamente.
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

    // 4. Crear el historial de reportes (Seed para el Ticket 5.2.1)
    console.log('📊 Generando 15 reportes para pruebas de paginación...');
    
    const reportsToInsert = [];
    
    // Le creamos 15 reportes falsos yendo hacia atrás en el tiempo
    for (let i = 0; i < 15; i++) {
      const date = new Date();
      date.setDate(date.getDate() - (i * 7)); // Un reporte por semana hacia atrás

      reportsToInsert.push({
        userId: user.id, // Usamos el ID del usuario Juan Pérez que acabamos de crear arriba
        reportDate: date,
        totalHours: Math.floor(Math.random() * (45 - 35 + 1)) + 35, // Horas random entre 35 y 45
        status: i % 3 === 0 ? 'PENDING' : 'SENT', // 1 de cada 3 estará pendiente
        xlsxUrl: i % 3 === 0 ? null : `https://autolog-bucket.s3.amazonaws.com/reports/report-${i}.xlsx`,
        sentAt: i % 3 === 0 ? null : new Date(),
      });
    }

    // Usamos 'tx' en vez de 'prisma' para mantener la transacción segura
    await tx.report.createMany({
      data: reportsToInsert,
      skipDuplicates: true,
    });

    console.log(`📝 15 Reportes automáticos creados y asignados a ${user.fullName}.`);
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