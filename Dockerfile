FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# 1. Copiamos solo los archivos de dependencias
COPY --chown=node:node package*.json ./

# El schema debe estar presente antes de `npm ci`: el postinstall corre
# `prisma generate`, que falla si no encuentra prisma/schema.prisma.
COPY --chown=node:node prisma ./prisma

RUN npm ci

# 3. Copiamos el resto del código fuente (incluyendo prisma/schema.prisma)
COPY --chown=node:node . .

RUN mkdir -p logs && chown -R node:node logs

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]