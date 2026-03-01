FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY patches/ ./patches/

RUN npm ci

COPY server.ts ./
COPY public/ ./public/

EXPOSE 8087

CMD ["node", "--experimental-strip-types", "server.ts"]
