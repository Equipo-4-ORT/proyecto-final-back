/**
 * Servicio de email del batch (CU-03 de la SPEC).
 *
 * Envía el aviso diario al empleado de que su actividad ya está disponible, con un
 * link al dashboard. Best-effort: si SMTP no está configurado, degrada (loguea y
 * no envía) sin romper el batch (V-02). Si está configurado y el envío falla, lanza
 * para que el dispatcher lo registre.
 */

const nodemailer = require('nodemailer');
const config = require('../../shared/config');
const logger = require('../../shared/utils/logger');

let transporter = null;

const getTransporter = () => {
    if (!transporter) {
        const { host, port, secure, user, pass } = config.smtp;
        transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            // Algunos relays internos no requieren auth; solo la mandamos si hay usuario.
            ...(user ? { auth: { user, pass } } : {}),
        });
    }
    return transporter;
};

const buildDashboardUrl = () => {
    const base = (config.frontendBaseUrl || '').replace(/\/+$/, '');
    return `${base}/dashboard`;
};

/**
 * Envía el email de aviso de actividad lista.
 *
 * @param {string} toEmail - dirección del propio empleado (RN-B08)
 * @param {{ date?: string }} [opts] - fecha del día sincronizado (para el texto)
 * @returns {Promise<{ sent: boolean, reason?: string, messageId?: string }>}
 */
const sendActivityReadyEmail = async (toEmail, { date } = {}) => {
    if (!config.smtpConfigured) {
        logger.warn('scheduler.email.skipped', { reason: 'smtp_not_configured' });
        return { sent: false, reason: 'smtp_not_configured' };
    }

    const dashboardUrl = buildDashboardUrl();
    const diaTexto = date ? ` del ${date}` : '';

    const info = await getTransporter().sendMail({
        from: config.smtp.from,
        to: toEmail,
        subject: 'Tu actividad del día ya está disponible',
        text:
            `Hola,\n\n` +
            `Ya sincronizamos tu actividad${diaTexto}. ` +
            `Podés revisarla y confirmar tu informe en el dashboard:\n${dashboardUrl}\n\n` +
            `— TimeTracker`,
        html:
            `<p>Hola,</p>` +
            `<p>Ya sincronizamos tu actividad${diaTexto}. ` +
            `Podés revisarla y confirmar tu informe en el dashboard:</p>` +
            `<p><a href="${dashboardUrl}">Ir al dashboard</a></p>` +
            `<p>— TimeTracker</p>`,
    });

    return { sent: true, messageId: info.messageId };
};

module.exports = {
    sendActivityReadyEmail,
    // Para tests: fuerza recrear el transporter (el singleton persiste entre tests del mismo archivo).
    _resetTransporter: () => { transporter = null; },
};
