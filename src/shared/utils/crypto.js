const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX_LENGTH = 64;        // 32 bytes para AES-256
const IV_HEX_LENGTH = 24;         // 12 bytes (estandar para AES-GCM)
const AUTH_TAG_HEX_LENGTH = 32;   // 16 bytes (128-bit GCM tag)
const HEX_REGEX = /^[0-9a-fA-F]+$/;

class InvalidCiphertextError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'InvalidCiphertextError';
    }
}

const assertHexString = (value, expectedLength, label, ErrorClass = Error) => {
    if (typeof value !== 'string' || value.length !== expectedLength || !HEX_REGEX.test(value)) {
        throw new ErrorClass(`${label} must be a ${expectedLength}-character hexadecimal string`);
    }
};

const SECRET_KEY = (() => {
    const key = process.env.ENCRYPTION_KEY;
    assertHexString(key, KEY_HEX_LENGTH, 'ENCRYPTION_KEY');
    return Buffer.from(key, 'hex');
})();

/**
 * Encripta un texto usando AES-256-GCM
 * @param {string} text - El texto plano (ej: refresh_token)
 * @returns {string} - Formato: "ivHex:authTagHex:encryptedHex"
 */
const encrypt = (text) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, SECRET_KEY, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
};

/**
 * Desencripta un texto previamente encriptado con AES-256-GCM
 * @param {string} hash - El string guardado en BD (Formato: "iv:authTag:encrypted")
 * @returns {string} - El texto plano original
 * @throws {InvalidCiphertextError} - Si el formato es inválido o los datos fueron alterados
 */
const decrypt = (hash) => {
    if (typeof hash !== 'string') {
        throw new InvalidCiphertextError('Hash must be a string');
    }

    const parts = hash.split(':');
    if (parts.length !== 3) {
        throw new InvalidCiphertextError('Invalid hash format. Expected "iv:authTag:encrypted"');
    }

    const [ivHex, authTagHex, encryptedText] = parts;
    assertHexString(ivHex, IV_HEX_LENGTH, 'iv', InvalidCiphertextError);
    assertHexString(authTagHex, AUTH_TAG_HEX_LENGTH, 'authTag', InvalidCiphertextError);

    const decipher = createDecipheriv(ALGORITHM, SECRET_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    try {
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        throw new InvalidCiphertextError('Unable to decrypt: data may be tampered or corrupted', { cause: error });
    }
};

module.exports = {
    encrypt,
    decrypt,
    InvalidCiphertextError
};
