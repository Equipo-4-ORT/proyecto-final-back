const {
  createUser,
  listUsers,
  toggleUserStatus,
  updateUser,
  UserAlreadyExistsError,
  UserNotFoundError,
} = require('./admin.service');
const { asignarRol } = require('../auth/auth.service');
const { createUserSchema, updateUserSchema } = require('./admin.validation');
const logger = require('../../shared/utils/logger');

const postUser = async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Bad Request', message: parsed.error.issues[0].message });
  }
  const { fullName, email } = parsed.data;

  try {
    // El role lo determina la app, no el cliente: sin llave de admin => EMPLOYEE.
    const role = asignarRol();
    const user = await createUser({ fullName, email, role });
    return res.status(201).json(user);
  } catch (error) {
    if (error instanceof UserAlreadyExistsError) {
      return res.status(error.statusCode).json({ error: error.name, message: error.message });
    }
    logger.error('Error al crear usuario desde admin', { error });
    return res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'No se pudo crear el usuario' });
  }
};

const getUsers = async (req, res) => {
  try {
    const users = await listUsers();
    return res.status(200).json(users);
  } catch (error) {
    logger.error('Error al listar usuarios', { error });
    return res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'No se pudieron obtener los usuarios' });
  }
};

const patchUserStatus = async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user?.id;

    if (String(targetUserId) === String(currentUserId)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Un administrador no puede cambiar el estado de su propia cuenta.'
      });
    }

    const user = await toggleUserStatus(req.params.id);
    return res.status(200).json(user);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      return res.status(error.statusCode).json({ error: error.name, message: error.message });
    }
    logger.error('Error al cambiar estado de usuario', { error });
    return res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'No se pudo actualizar el usuario' });
  }
};

const editUser = async (req, res) => {
  const { id } = req.params;

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Bad Request', message: parsed.error.issues[0].message });
  }

  try {
    // role no se incluye a propósito: no es editable desde el front (lo descarta el schema).
    const updatedUser = await updateUser(id, parsed.data);
    return res.status(200).json(updatedUser);
  } catch (error) {
    if (error instanceof UserNotFoundError || error instanceof UserAlreadyExistsError) {
      return res.status(error.statusCode).json({ error: error.name, message: error.message });
    }
    logger.error('Error al actualizar usuario', { error });
    return res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'No se pudo actualizar el usuario' });
  }
};

module.exports = { postUser, getUsers, patchUserStatus, editUser };
