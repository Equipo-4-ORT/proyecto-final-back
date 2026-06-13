FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./

# Copy the Prisma schema before install so the postinstall "prisma generate" hook can find it
COPY --chown=node:node prisma ./prisma

RUN npm ci

COPY --chown=node:node . .

RUN mkdir -p logs && chown -R node:node logs

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
