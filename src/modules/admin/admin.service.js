const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');

class UserAlreadyExistsError extends Error {
  constructor(email) {
    super(`El email ${email} ya está registrado`);
    this.name = 'UserAlreadyExistsError';
    this.statusCode = 409;
  }
}

class UserNotFoundError extends Error {
  constructor(id) {
    super(`Usuario ${id} no encontrado`);
    this.name = 'UserNotFoundError';
    this.statusCode = 404;
  }
}

const createUser = async ({ fullName, email, role }) => {
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    throw new UserAlreadyExistsError(normalizedEmail);
  }

  const user = await prisma.user.create({
    data: {
      fullName,
      email: normalizedEmail,
      role,
      status: 'ACTIVE',
    },
    select: { id: true, fullName: true, email: true, role: true, status: true, createdAt: true },
  });

  logger.info('Admin creó nuevo usuario', { email: normalizedEmail, role });
  return user;
};

const listUsers = async () => {
  return prisma.user.findMany({
    select: { id: true, fullName: true, email: true, role: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
};

const toggleUserStatus = async (id) => {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new UserNotFoundError(id);

  const newStatus = user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

  return prisma.user.update({
    where: { id },
    data: { status: newStatus },
    select: { id: true, fullName: true, email: true, role: true, status: true, createdAt: true },
  });
};

module.exports = { createUser, listUsers, toggleUserStatus, UserAlreadyExistsError, UserNotFoundError };
