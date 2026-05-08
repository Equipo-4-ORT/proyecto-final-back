FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./

RUN npm ci

COPY --chown=node:node . .

RUN npx prisma generate

RUN mkdir -p logs && chown -R node:node logs

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
