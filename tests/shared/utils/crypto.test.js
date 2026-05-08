const nodeCrypto = require('crypto');

// La key se setea ANTES del require porque crypto.js la lee y cachea al cargar el módulo
process.env.ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('hex');

const { encrypt, decrypt, InvalidCiphertextError } = require('../../../src/shared/utils/crypto');

describe('Modulo de Encriptación (AES-256-GCM)', () => {
    test('Debe encriptar y desencriptar un texto correctamente', () => {
        const textoOriginal = 'refresh_token_secreto_123';

        const encriptado = encrypt(textoOriginal);
        const desencriptado = decrypt(encriptado);

        expect(desencriptado).toBe(textoOriginal);
    });

    test('El texto encriptado debe tener el formato correcto (iv:authTag:hash)', () => {
        const encriptado = encrypt('texto_prueba');
        const partes = encriptado.split(':');

        expect(partes.length).toBe(3);
    });

    test('encrypt() del mismo input dos veces produce outputs distintos (IV aleatorio)', () => {
        const texto = 'mismo_texto';

        expect(encrypt(texto)).not.toBe(encrypt(texto));
    });

    test('decrypt() lanza InvalidCiphertextError si el authTag fue manipulado', () => {
        const encriptado = encrypt('dato_secreto');
        const [iv, authTag, ciphertext] = encriptado.split(':');
        const tamperedAuthTag = (authTag[0] === '0' ? '1' : '0') + authTag.slice(1);
        const tampered = `${iv}:${tamperedAuthTag}:${ciphertext}`;

        expect(() => decrypt(tampered)).toThrow(InvalidCiphertextError);
    });

    test('decrypt() lanza error si el formato no tiene 3 partes', () => {
        expect(() => decrypt('solo_una_parte')).toThrow(InvalidCiphertextError);
        expect(() => decrypt('una:dos')).toThrow(InvalidCiphertextError);
        expect(() => decrypt('una:dos:tres:cuatro')).toThrow(InvalidCiphertextError);
    });

    test('decrypt() lanza error si el hash no es string', () => {
        expect(() => decrypt(null)).toThrow(InvalidCiphertextError);
        expect(() => decrypt(undefined)).toThrow(InvalidCiphertextError);
        expect(() => decrypt(12345)).toThrow(InvalidCiphertextError);
    });

    test('decrypt() lanza error si el IV no es hex válido', () => {
        const encriptado = encrypt('dato');
        const [, authTag, ciphertext] = encriptado.split(':');
        const ivNoHex = 'zzzzzzzzzzzzzzzzzzzzzzzz'; // 24 chars pero no hex

        expect(() => decrypt(`${ivNoHex}:${authTag}:${ciphertext}`)).toThrow(InvalidCiphertextError);
    });

    test('decrypt() lanza error si el IV tiene largo incorrecto', () => {
        const encriptado = encrypt('dato');
        const [, authTag, ciphertext] = encriptado.split(':');

        expect(() => decrypt(`abcd:${authTag}:${ciphertext}`)).toThrow(InvalidCiphertextError);
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
