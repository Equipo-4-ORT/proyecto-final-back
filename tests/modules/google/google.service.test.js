process.env.GOOGLE_CLIENT_ID = 'test-client-id';
const { verifyGoogleToken } = require('../../../src/modules/google/google.service');
const { OAuth2Client } = require('google-auth-library');

jest.mock('google-auth-library');

describe('Servicio de Google Auth (verifyGoogleToken)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Debe retornar todos los datos del usuario mapeados si el token es válido', async () => {
        const mockPayload = {
            sub: '1234567890',
            email: 'jperez@finnegans.com.ar',
            name: 'Juan Pérez',
            picture: 'https://example.com/foto.png',
            email_verified: true
        };

        OAuth2Client.prototype.verifyIdToken.mockResolvedValue({
            getPayload: () => mockPayload
        });

        const result = await verifyGoogleToken('token_falso_pero_valido');

        expect(result).toEqual({
            googleId: '1234567890',
            email: 'jperez@finnegans.com.ar',
            fullName: 'Juan Pérez',
            picture: 'https://example.com/foto.png',
            emailVerified: true
        });
    });

    test('Debe lanzar "Token requerido" si el token está vacío, null, undefined o no es string', async () => {
        await expect(verifyGoogleToken('')).rejects.toThrow('Token requerido');
        await expect(verifyGoogleToken(null)).rejects.toThrow('Token requerido');
        await expect(verifyGoogleToken(undefined)).rejects.toThrow('Token requerido');
        await expect(verifyGoogleToken(12345)).rejects.toThrow('Token requerido');
    });

    test('Debe lanzar "Invalid Google token" si Google rechaza el token', async () => {
        OAuth2Client.prototype.verifyIdToken.mockRejectedValue(new Error('Token expirado'));

        await expect(verifyGoogleToken('token_invalido')).rejects.toThrow('Invalid Google token');
    });

    test('Debe lanzar "Email no verificado" si Google no verificó el email', async () => {
        OAuth2Client.prototype.verifyIdToken.mockResolvedValue({
            getPayload: () => ({
                sub: '1234567890',
                email: 'unverified@x.com',
                name: 'Test',
                email_verified: false
            })
        });

        await expect(verifyGoogleToken('token_de_email_no_verificado'))
            .rejects.toThrow('Email no verificado por Google');
    });
});
