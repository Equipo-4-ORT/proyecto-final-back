// tests/googleAuth.test.js
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
const { verifyGoogleToken } = require('../../../src/shared/services/googleAuth');
const { OAuth2Client } = require('google-auth-library');

// Le decimos a Jest que intercepte y falsifique la librería de Google
jest.mock('google-auth-library');

describe('Servicio de Google Auth', () => {
    test('Debe retornar los datos del usuario si el token es válido', async () => {
        // Configuramos qué queremos que responda el "simulador" de Google
        const mockPayload = {
            sub: '1234567890',
            email: 'jperez@finnegans.com.ar',
            name: 'Juan Pérez',
            picture: 'url_foto',
            email_verified: true
        };

        // Simulamos que la función verifyIdToken devuelve nuestro payload falso
        OAuth2Client.prototype.verifyIdToken.mockResolvedValue({
            getPayload: () => mockPayload
        });

        // Ejecutamos nuestra función con un token falso
        const result = await verifyGoogleToken('token_falso_pero_valido');

        // Validamos que nuestra función mapeó correctamente los datos
        expect(result.email).toBe('jperez@finnegans.com.ar');
        expect(result.googleId).toBe('1234567890');
    });
});