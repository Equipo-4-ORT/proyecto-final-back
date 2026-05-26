process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';

const { google } = require('googleapis');
const { getCalendarEventsForDay, persistCalendarActivities } = require('../../../src/modules/calendar/calendar.service');
const { getAuthenticatedGoogleClient } = require('../../../src/modules/google/google.service');
const prisma = require('../../../src/shared/database/prisma');

// 1. Mockeamos las dependencias externas
jest.mock('googleapis', () => ({
  google: {
    calendar: jest.fn()
  }
}));
jest.mock('../../../src/modules/google/google.service');
jest.mock('../../../src/shared/database/prisma', () => ({
  dailyActivity: {
    createMany: jest.fn().mockResolvedValue({ count: 0 })
  }
}));

describe('Calendar Service', () => {
  let mockEventsList;

  beforeEach(() => {
    // Limpiamos el estado de los mocks antes de cada test
    jest.clearAllMocks();

    // Simulamos el cliente de Google Auth
    getAuthenticatedGoogleClient.mockReturnValue({});

    // Preparamos el mock profundo de google.calendar().events.list()
    mockEventsList = jest.fn();
    google.calendar.mockReturnValue({
      events: {
        list: mockEventsList
      }
    });
  });

  // ====================================================================
  // SUITE 1: getCalendarEventsForDay (Traer eventos de Google)
  // ====================================================================
  describe('getCalendarEventsForDay', () => {
    test('Devuelve un array vacío si no hay eventos', async () => {
      mockEventsList.mockResolvedValue({ data: { items: [] } });
      const result = await getCalendarEventsForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');
      expect(result).toEqual([]);
      expect(mockEventsList).toHaveBeenCalledTimes(1);
    });

    test('Devuelve eventos correctamente mapeados', async () => {
      const mockEvent = { id: '123', summary: 'Reunión' };
      mockEventsList.mockResolvedValue({ data: { items: [mockEvent] } });
      const result = await getCalendarEventsForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');
      expect(result).toHaveLength(1);
      expect(result[0].summary).toBe('Reunión');
    });
  });

  // ====================================================================
  // SUITE 2: persistCalendarActivities (Lógica de negocio y BD)
  // ====================================================================
  describe('persistCalendarActivities', () => {
    const mockUserId = 'user-uuid-123';
    const mockDateStr = '2026-05-26';

    test('Filtra eventos de todo el día, sin asistentes y declinados', async () => {
      const allDayEvent = {
        id: '1', summary: 'Feriado',
        start: { date: '2026-05-26' }, end: { date: '2026-05-27' }
      };
      const noAttendeesEvent = {
        id: '2', summary: 'Tiempo de foco',
        start: { dateTime: '2026-05-26T10:00:00Z' }, end: { dateTime: '2026-05-26T11:00:00Z' }
      };
      const declinedEvent = {
        id: '3', summary: 'Reunión rechazada',
        start: { dateTime: '2026-05-26T12:00:00Z' }, end: { dateTime: '2026-05-26T13:00:00Z' },
        attendees: [{ email: 'yo@test.com', self: true, responseStatus: 'declined' }, { email: 'otro@test.com' }]
      };

      // Le pasamos los 3 eventos inválidos a la API
      mockEventsList.mockResolvedValue({ data: { items: [allDayEvent, noAttendeesEvent, declinedEvent] } });

      const result = await persistCalendarActivities(mockUserId, 'token', mockDateStr);

      // Verificamos que no se haya llamado a Prisma y devuelva count 0
      expect(result.count).toBe(0);
      expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
    });

    test('Guarda eventos válidos e identifica si es de Google Meet', async () => {
      const validMeetEvent = {
        id: '4', summary: 'Sprint Planning',
        start: { dateTime: '2026-05-26T14:00:00Z' }, end: { dateTime: '2026-05-26T15:00:00Z' },
        organizer: { email: 'scrum@test.com' },
        attendees: [{ email: 'yo@test.com', self: true, responseStatus: 'accepted' }, { email: 'mateo@test.com' }],
        conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } } },
        hangoutLink: 'https://meet.google.com/abc'
      };

      const validNormalEvent = {
        id: '5', summary: 'Charla presencial',
        start: { dateTime: '2026-05-26T16:00:00Z' }, end: { dateTime: '2026-05-26T17:00:00Z' },
        attendees: [{ email: 'yo@test.com', self: true, responseStatus: 'needsAction' }, { email: 'jefe@test.com' }]
      };

      mockEventsList.mockResolvedValue({ data: { items: [validMeetEvent, validNormalEvent] } });
      prisma.dailyActivity.createMany.mockResolvedValue({ count: 2 });

      const result = await persistCalendarActivities(mockUserId, 'token', mockDateStr);

      expect(result.count).toBe(2);
      expect(prisma.dailyActivity.createMany).toHaveBeenCalledTimes(1);

      // Verificamos que los datos se mapeen correctamente para la BD
      const dataPassedToPrisma = prisma.dailyActivity.createMany.mock.calls[0][0].data;
      
      expect(dataPassedToPrisma).toHaveLength(2);
      
      // Verificamos la detección de Meet
      expect(dataPassedToPrisma[0].activityType).toBe('meeting');
      expect(dataPassedToPrisma[0].metadata.link).toBe('https://meet.google.com/abc');
      
      // Verificamos un evento normal
      expect(dataPassedToPrisma[1].activityType).toBe('event');
      expect(dataPassedToPrisma[1].metadata.link).toBeNull();
    });
  });
});