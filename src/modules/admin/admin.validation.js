const z = require('zod');

// Regex de email reutilizada por el alta y la edición de usuarios.
// (Antes estaba duplicada inline en admin.controller.js).
const EMAIL_REGEX = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const fullNameSchema = z
  .string()
  .trim()
  .min(1, 'El nombre no puede estar vacío')
  .max(100, 'El nombre no puede superar los 100 caracteres');

const emailSchema = z.string().trim().regex(EMAIL_REGEX, 'El email no tiene un formato válido');

// Alta de usuario: fullName y email son requeridos.
// El `role` NO se acepta del cliente a propósito: lo determina el server
// (asignarRol => EMPLOYEE, salvo el bootstrap del único admin con su key).
// Al no estar en el schema, cualquier `role` que mande el front se descarta.
const createUserSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
});

// Edición de usuario: fullName y email son opcionales, pero debe venir al menos uno.
// El `role` tampoco es editable desde el front (mismo motivo que en el alta).
const updateUserSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    email: emailSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Debe enviar al menos un campo para actualizar (fullName o email)',
  });

module.exports = { createUserSchema, updateUserSchema, EMAIL_REGEX };
