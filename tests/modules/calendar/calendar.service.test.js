process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';

const { google } = require('googleapis');
const {
  getCalendarEventsForDay,
  persistCalendarActivities,
} = require('../../../src/modules/calendar/calendar.service');
const { getAuthenticatedGoogleClient } = require('../../../src/modules/google/google.service');
const prisma = require('../../../src/shared/database/prisma');

// 1. Mockeamos las dependencias externas
jest.mock('googleapis', () => ({
  google: {
    calendar: jest.fn(),
  },
}));
jest.mock('../../../src/modules/google/google.service');
jest.mock('../../../src/shared/database/prisma', () => ({
  dailyActivity: {
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
}));
jest.mock('../../../src/shared/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
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
        list: mockEventsList,
      },
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

    test('Devuelve los eventos que retorna la API', async () => {
      const mockEvent = { id: '123', summary: 'Reunión' };
      mockEventsList.mockResolvedValue({ data: { items: [mockEvent] } });
      const result = await getCalendarEventsForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');
      expect(result).toHaveLength(1);
      expect(result[0].summary).toBe('Reunión');
    });

    test('Lanza un error si la API de Google falla', async () => {
      mockEventsList.mockRejectedValue(new Error('Google API down'));
      await expect(
        getCalendarEventsForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z'),
      ).rejects.toThrow('Error fetching calendar events');
    });
  });

  // ====================================================================
  // SUITE 2: persistCalendarActivities (Lógica de negocio y BD)
  // ====================================================================
  describe('persistCalendarActivities', () => {
    const mockUserId = 'user-uuid-123';
    const mockDateStr = '2026-05-26';

    test('Descarta eventos de todo el día, sin asistentes, declinados y no confirmados', async () => {
      const allDayEvent = {
        id: '1',
        summary: 'Feriado',
        start: { date: '2026-05-26' },
        end: { date: '2026-05-27' },
      };
      const noAttendeesEvent = {
        id: '2',
        summary: 'Tiempo de foco',
        start: { dateTime: '2026-05-26T10:00:00Z' },
        end: { dateTime: '2026-05-26T11:00:00Z' },
      };
      const declinedEvent = {
        id: '3',
        summary: 'Reunión rechazada',
        start: { dateTime: '2026-05-26T12:00:00Z' },
        end: { dateTime: '2026-05-26T13:00:00Z' },
        attendees: [
          { email: 'yo@test.com', self: true, responseStatus: 'declined' },
          { email: 'otro@test.com' },
        ],
      };
      const needsActionEvent = {
        id: '4',
        summary: 'Invitación sin responder',
        start: { dateTime: '2026-05-26T14:00:00Z' },
        end: { dateTime: '2026-05-26T15:00:00Z' },
        attendees: [
          { email: 'yo@test.com', self: true, responseStatus: 'needsAction' },
          { email: 'otro@test.com' },
        ],
      };
      const tentativeEvent = {
        id: '5',
        summary: 'Quizás voy',
        start: { dateTime: '2026-05-26T16:00:00Z' },
        end: { dateTime: '2026-05-26T17:00:00Z' },
        attendees: [
          { email: 'yo@test.com', self: true, responseStatus: 'tentative' },
          { email: 'otro@test.com' },
        ],
      };

      mockEventsList.mockResolvedValue({
        data: { items: [allDayEvent, noAttendeesEvent, declinedEvent, needsActionEvent, tentativeEvent] },
      });

      const result = await persistCalendarActivities(mockUserId, 'token', mockDateStr);

      // Ninguno cumple "el usuario aceptó" => no se llama a Prisma y count 0
      expect(result.count).toBe(0);
      expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
    });

    test('Guarda eventos aceptados (sea invitado u organizador) e identifica Google Meet', async () => {
      // El usuario es invitado (organizer es otro) y aceptó => se guarda como meeting
      const acceptedMeetEvent = {
        id: '10',
        summary: 'Sprint Planning',
        start: { dateTime: '2026-05-26T14:00:00Z' },
        end: { dateTime: '2026-05-26T15:00:00Z' },
        organizer: { email: 'scrum@test.com' },
        attendees: [
          { email: 'yo@test.com', self: true, responseStatus: 'accepted' },
          { email: 'mateo@test.com' },
        ],
        conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } } },
        hangoutLink: 'https://meet.google.com/abc',
      };

      // El usuario es organizador y aceptó => se guarda como evento normal
      const acceptedOwnEvent = {
        id: '11',
        summary: 'Charla presencial',
        start: { dateTime: '2026-05-26T16:00:00Z' },
        end: { dateTime: '2026-05-26T17:00:00Z' },
        organizer: { email: 'yo@test.com', self: true },
        attendees: [
          { email: 'yo@test.com', self: true, responseStatus: 'accepted' },
          { email: 'jefe@test.com' },
        ],
      };

      mockEventsList.mockResolvedValue({ data: { items: [acceptedMeetEvent, acceptedOwnEvent] } });
      prisma.dailyActivity.createMany.mockResolvedValue({ count: 2 });

      const result = await persistCalendarActivities(mockUserId, 'token', mockDateStr);

      expect(result.count).toBe(2);
      expect(prisma.dailyActivity.createMany).toHaveBeenCalledTimes(1);

      // Verificamos que los datos se mapeen correctamente para la BD
      const dataPassedToPrisma = prisma.dailyActivity.createMany.mock.calls[0][0].data;
      expect(dataPassedToPrisma).toHaveLength(2);

      // Evento con Meet
      expect(dataPassedToPrisma[0].activityType).toBe('meeting');
      expect(dataPassedToPrisma[0].title).toBe('Sprint Planning');
      expect(dataPassedToPrisma[0].externalId).toBe('10');
      expect(dataPassedToPrisma[0].metadata.link).toBe('https://meet.google.com/abc');
      expect(dataPassedToPrisma[0].metadata.organizer).toBe('scrum@test.com');

      // Evento normal
      expect(dataPassedToPrisma[1].activityType).toBe('event');
      expect(dataPassedToPrisma[1].title).toBe('Charla presencial');
      expect(dataPassedToPrisma[1].metadata.link).toBeNull();
    });
  });
});
