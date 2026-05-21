const {
  createUser,
  listUsers,
  toggleUserStatus,
  UserAlreadyExistsError,
  UserNotFoundError,
} = require('./admin.service');
const { asignarRol } = require('../auth/auth.service');
const logger = require('../../shared/utils/logger');

const postUser = async (req, res) => {
  const { fullName, email } = req.body;

  if (!fullName || !email) {
    return res
      .status(400)
      .json({ error: 'Bad Request', message: 'fullName y email son requeridos' });
  }

  const emailRegex = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
  if (!emailRegex.test(email)) {
    return res
      .status(400)
      .json({ error: 'Bad Request', message: 'El email no tiene un formato válido' });
  }

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

module.exports = { postUser, getUsers, patchUserStatus };
