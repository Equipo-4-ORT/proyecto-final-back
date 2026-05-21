const { mergeTimeline, groupByApp } = require("../../../src/modules/timeline/timeline.service");


describe('Timeline Service', () => {
  
  // ====================================================================
  // TESTS PARA mergeTimeline (Fusión y Ordenamiento)
  // ====================================================================
  describe('mergeTimeline()', () => {
    
    test('Caso 1: Día vacío (sin actividades) devuelve un array vacío', () => {
      const result = mergeTimeline([], []);
      expect(result).toEqual([]);
    });

    test('Caso 2: Actividades sin endTime en Drive se normalizan sumando 15 minutos', () => {
      // Actividad de 1 solo minuto / instante (Drive suele mandar esto)
      const driveActivities = [
        { id: 1, source: 'drive', startTime: '2026-05-21T10:00:00.000Z' }
      ];
      
      const result = mergeTimeline([], driveActivities);
      
      expect(result).toHaveLength(1);
      // 10:00 + 15 mins = 10:15
      expect(result[0].endTime).toBe('2026-05-21T10:15:00.000Z');
    });

    test('Caso 3: Ordena cronológicamente sin importar el origen', () => {
      const calendarActivities = [
        { id: 'C1', startTime: '2026-05-21T11:00:00.000Z' }, // Última
        { id: 'C2', startTime: '2026-05-21T09:00:00.000Z' }  // Primera
      ];
      const driveActivities = [
        { id: 'D1', startTime: '2026-05-21T10:00:00.000Z', endTime: '2026-05-21T10:30:00.000Z' } // Medio
      ];
      
      const result = mergeTimeline(calendarActivities, driveActivities);
      
      expect(result[0].id).toBe('C2'); // 09:00
      expect(result[1].id).toBe('D1'); // 10:00
      expect(result[2].id).toBe('C1'); // 11:00
    });
  });

  // ====================================================================
  // TESTS PARA groupByApp (Agrupación para el Frontend)
  // ====================================================================
  describe('groupByApp()', () => {
    
    test('Caso 4: Solapamientos múltiples (Reunión de 2h con edición de Docs al mismo tiempo)', () => {
      // Simulamos que editó un documento MIENTRAS estaba en la reunión
      const activities = [
        { 
          id: 1, 
          source: 'calendar', 
          title: 'Planning de Arquitectura', 
          startTime: '2026-05-21T14:00:00.000Z',
          endTime: '2026-05-21T16:00:00.000Z', // Reunión de 2 horas
          metadata_json: { link: 'https://meet.google.com/abc-defg-hij' }
        },
        { 
          id: 2, 
          source: 'drive', 
          title: 'Diseño Base de Datos',
          startTime: '2026-05-21T14:30:00.000Z', // Solapado
          metadata_json: { mimeType: 'application/vnd.google-apps.document' }
        }
      ];
      
      const result = groupByApp(activities);
      
      expect(result.Meet).toHaveLength(1);
      expect(result.Docs).toHaveLength(1);
      // Validamos que los otros cajones estén vacíos
      expect(result.Calendar).toHaveLength(0);
      expect(result.Sheets).toHaveLength(0);
      expect(result.Drive).toHaveLength(0);
    });

    test('Caso 5: Todo el día en reuniones de Meet', () => {
      const activities = [
        { source: 'calendar', title: 'Daily Meet', metadata_json: { link: 'meet.google.com/123' } },
        { source: 'calendar', title: 'Planning', metadata_json: { link: 'meet.google.com/456' } },
        { source: 'calendar', title: 'Retro de Sprint', metadata_json: { link: 'meet.google.com/789' } }
      ];
      
      const result = groupByApp(activities);
      
      expect(result.Meet).toHaveLength(3); // Las 3 fueron a Meet
      expect(result.Calendar).toHaveLength(0); // Ninguna fue a Calendar genérico
    });

    test('Caso 6: Actividades de un solo minuto y archivos generales', () => {
      const activities = [
        { 
          source: 'drive', 
          title: 'diagrama_arquitectura.png',
          startTime: '2026-05-21T10:00:00.000Z',
          endTime: '2026-05-21T10:01:00.000Z', // Duró 1 minuto
          metadata_json: { mimeType: 'image/png' } // No es un Doc ni un Sheet
        }
      ];
      
      const result = groupByApp(activities);
      
      expect(result.Drive).toHaveLength(1); // Va a la bolsa general de Drive
      expect(result.Docs).toHaveLength(0);
      expect(result.Sheets).toHaveLength(0);
    });
  });

});