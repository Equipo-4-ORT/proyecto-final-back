// tests/crypto.test.js
const nodeCrypto = require('crypto');

// La key se setea ANTES del require porque crypto.js la lee y cachea al cargar el módulo
process.env.ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('hex');

const { encrypt, decrypt } = require('../../../src/shared/utils/crypto');

describe('Modulo de Encriptación (AES-256-GCM)', () => {
    test('Debe encriptar y desencriptar un texto correctamente', () => {
        const textoOriginal = "refresh_token_secreto_123";

        const encriptado = encrypt(textoOriginal);
        const desencriptado = decrypt(encriptado);

        expect(desencriptado).toBe(textoOriginal);
    });

    test('El texto encriptado debe tener el formato correcto (iv:authTag:hash)', () => {
        const textoOriginal = "texto_prueba";
        const encriptado = encrypt(textoOriginal);

        const partes = encriptado.split(':');
        expect(partes.length).toBe(3);
    });

    test('Debe lanzar un error si la key no tiene 64 caracteres', () => {
        const originalKey = process.env.ENCRYPTION_KEY;
        jest.isolateModules(() => {
            process.env.ENCRYPTION_KEY = 'llave_corta';
            expect(() => require('../../../src/shared/utils/crypto')).toThrow(/must be a 64-character/);
        });
        process.env.ENCRYPTION_KEY = originalKey;
    });
});
