const z = require('zod');

// Regex de email reutilizada por el alta y la edición de usuarios.
// (Antes estaba duplicada inline en admin.controller.js).
const EMAIL_REGEX = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

// Regex para validar el nombre (solo letras, espacios, acentos y ñ/Ñ)
const NAME_REGEX = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/;

const fullNameSchema = z
  .string({
    required_error: "El nombre no tiene un formato válido.",
    invalid_type_error: "El nombre no tiene un formato válido."
  })
  .trim()
  .min(1, 'El nombre no puede estar vacío')
  .max(100, 'El nombre no puede superar los 100 caracteres')
  .regex(NAME_REGEX, "El nombre no tiene un formato válido");

const emailSchema = z.string({
  required_error: "El campo email es inválido",
  invalid_type_error: "El campo email es inválido"
}).trim().regex(EMAIL_REGEX, 'El campo email es inválido');

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
