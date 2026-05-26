const {google} = require('googleapis');
const {getAuthenticatedGoogleClient} = require('../google/google.service');
const prisma = require('../../shared/database/prisma');

const getCalendarEventsForDay = async (refreshToken, timeMin, timeMax) => {
    try{
        const auth = getAuthenticatedGoogleClient(refreshToken);
        const calendar = google.calendar({version: 'v3', auth});
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: timeMin,
            timeMax: timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });
        return response.data.items || [];

    } catch (error) {
        console.error('Error fetching calendar events:', error);
        throw new Error('Error fetching calendar events', { cause: error });
    }
};


const persistCalendarActivities = async (userId, refreshToken, dateStr) => {
    const startDate = new Date(dateStr);
    const timeMin = startDate.toISOString();

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    const timeMax = endDate.toISOString();

    const rawEvents = await getCalendarEventsForDay(refreshToken, timeMin, timeMax);

    const activitiesToSave = [];

    for (const event of rawEvents) {
        //console.log(`\n🔍 Evaluando evento: "${event.summary || 'Sin título'}"`);
        if (!event.start?.dateTime || !event.end?.dateTime) { 
           // console.log(`   ❌ Descartado: No tiene dateTime exacto (probablemente evento de todo el día)`);
            continue; // Ignorar eventos sin fecha/hora de inicio
        
        }
        if (!event.attendees || event.attendees.length === 0) { 
            // console.log(`   ❌ Descartado: No tiene asistentes`);
            continue; // Ignorar eventos sin asistentes
        }

        const userAttendee = event.attendees.find(a => a.email === event.organizer?.email || a.self);
        if (userAttendee && userAttendee.responseStatus === 'declined'){ 
            // console.log(`   ❌ Descartado: El usuario ha rechazado la invitación`);
            continue; // Ignorar eventos donde el usuario no es organizador ni asistente, o donde el usuario ha rechazado la invitación 
        }

        // console.log(`   ✅ ¡EVENTO ACEPTADO! Pasa todos los filtros.`);

        const isMeet = event.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet';

        activitiesToSave.push({
         userId: userId, //
      source: 'calendar', //
      activityType: isMeet ? 'meeting' : 'event', //
      externalId: event.id, // Usamos el ID del evento para evitar duplicados futuros
      startTime: new Date(event.start.dateTime), //
      endTime: new Date(event.end.dateTime), //
      metadata: { //
        title: event.summary || 'Sin título',
        link: event.hangoutLink || null,
        organizer: event.organizer?.email || null
      }
        });
    

    };

    if (activitiesToSave.length === 0) {
        return { count: 0, message: 'No se encontraron actividades relevantes para guardar' };
    }

    // console.log(`\n💾 [DEBUG] Intentando insertar ${activitiesToSave.length} filas en Prisma...`);

    const result = await prisma.dailyActivity.createMany({
        data: activitiesToSave,
        skipDuplicates: true, // Evita insertar actividades con el mismo externalId
    });
    // console.log(`🎉 [EXITO] Insertadas ${result.count} actividades.`);
    return { count: result.count, message: `${result.count} actividades de calendario guardadas` };
}
module.exports = {
    getCalendarEventsForDay,
    persistCalendarActivities
};