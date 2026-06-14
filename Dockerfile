FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# 1. Copiamos solo los archivos de dependencias
COPY --chown=node:node package*.json ./

# 2. Instalamos esquivando el postinstall automático de Prisma
RUN npm ci --ignore-scripts

# 3. Copiamos el resto del código fuente (incluyendo prisma/schema.prisma)
COPY --chown=node:node . .

# 4. Ahora sí generamos los binarios de Prisma de forma manual
RUN npx prisma generate

RUN mkdir -p logs && chown -R node:node logs

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]