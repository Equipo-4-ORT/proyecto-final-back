const { isSafeDomain, groupByApp } = require("../../../src/modules/timeline/timeline.service");

describe('Timeline Service', () => {

  // ====================================================================
  // TESTS PARA isSafeDomain (Validación de dominio)
  // ====================================================================
  describe('isSafeDomain()', () => {

    test.each([
      ['https://meet.google.com/abc-defg-hij', 'meet.google.com', true],
      ['https://sub.meet.google.com/foo', 'meet.google.com', true],
      ['https://docs.google.com/document/d/123', 'docs.google.com', true],
      ['https://evilmeet.google.com', 'meet.google.com', false],
      ['https://meet.google.com.attacker.com', 'meet.google.com', false],
      ['https://attacker.com/?redirect=https://meet.google.com', 'meet.google.com', false],
      ['javascript:alert(1)', 'meet.google.com', false],
      ['not a url at all', 'meet.google.com', false],
      ['', 'meet.google.com', false],
      [null, 'meet.google.com', false],
      [undefined, 'meet.google.com', false],
    ])('isSafeDomain(%p, %p) === %p', (url, domain, expected) => {
      expect(isSafeDomain(url, domain)).toBe(expected);
    });
  });

  // ====================================================================
  // TESTS PARA groupByApp (Agrupación para el Frontend / IA)
  // ====================================================================
  describe('groupByApp()', () => {

    test('Caso 1: Solapamientos múltiples (Reunión de 2h con edición de Docs al mismo tiempo)', () => {
      // Simulamos que editó un documento MIENTRAS estaba en la reunión
      const activities = [
        {
          id: 1,
          source: 'calendar',
          title: 'Planning de Arquitectura',
          startTime: '2026-05-21T14:00:00.000Z',
          endTime: '2026-05-21T16:00:00.000Z',
          metadata: { link: 'https://meet.google.com/abc-defg-hij' }
        },
        {
          id: 2,
          source: 'drive',
          title: 'Diseño Base de Datos',
          startTime: '2026-05-21T14:30:00.000Z',
          metadata: { mimeType: 'application/vnd.google-apps.document' }
        }
      ];

      const result = groupByApp(activities);

      expect(result.Meet).toHaveLength(1);
      expect(result.Docs).toHaveLength(1);
      expect(result.Calendar).toHaveLength(0);
      expect(result.Sheets).toHaveLength(0);
      expect(result.Drive).toHaveLength(0);
    });

    test('Caso 2: Todo el día en reuniones de Meet (link de meet.google.com)', () => {
      const activities = [
        { source: 'calendar', title: 'Daily', metadata: { link: 'https://meet.google.com/123' } },
        { source: 'calendar', title: 'Planning', metadata: { link: 'https://meet.google.com/456' } },
        { source: 'calendar', title: 'Retro de Sprint', metadata: { link: 'https://meet.google.com/789' } }
      ];

      const result = groupByApp(activities);

      expect(result.Meet).toHaveLength(3);
      expect(result.Calendar).toHaveLength(0);
    });

    test('Caso 3: Evento de Calendar sin link de Meet cae en Calendar aunque el título diga "meet"', () => {
      const activities = [
        { source: 'calendar', title: 'Meeting con cliente presencial', metadata: {} },
        { source: 'calendar', title: 'Meet con Juan en la cafetería', metadata: {} },
      ];

      const result = groupByApp(activities);

      expect(result.Calendar).toHaveLength(2);
      expect(result.Meet).toHaveLength(0);
    });

    test('Caso 4: Actividades de un solo minuto y archivos generales', () => {
      const activities = [
        {
          source: 'drive',
          title: 'diagrama_arquitectura.png',
          startTime: '2026-05-21T10:00:00.000Z',
          endTime: '2026-05-21T10:01:00.000Z',
          metadata: { mimeType: 'image/png' }
        }
      ];

      const result = groupByApp(activities);

      expect(result.Drive).toHaveLength(1);
      expect(result.Docs).toHaveLength(0);
      expect(result.Sheets).toHaveLength(0);
    });

    test('Caso 5: Slides se agrupan en su propio bucket', () => {
      const activities = [
        { source: 'drive', metadata: { mimeType: 'application/vnd.google-apps.presentation' } },
        { source: 'drive', metadata: { link: 'https://slides.google.com/presentation/d/xyz' } },
      ];

      const result = groupByApp(activities);

      expect(result.Slides).toHaveLength(2);
      expect(result.Drive).toHaveLength(0);
    });

    test('Caso 6: Actividades de Jira van al bucket Jira', () => {
      const activities = [
        { source: 'jira', title: 'PROJ-123 fix bug', metadata: {} },
        { source: 'jira', title: 'PROJ-124 add feature', metadata: {} },
      ];

      const result = groupByApp(activities);

      expect(result.Jira).toHaveLength(2);
      expect(result.Other).toHaveLength(0);
    });

    test('Caso 7: Manual y sources desconocidos caen en Other (no se pierden)', () => {
      const activities = [
        { source: 'manual', title: 'Almuerzo', metadata: {} },
        { source: 'wakatime', title: 'coding', metadata: {} },
        { source: '', title: 'sin source', metadata: {} },
      ];

      const result = groupByApp(activities);

      expect(result.Other).toHaveLength(3);
    });
  });

});
