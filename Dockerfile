FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY server.js ./
COPY public/ ./public/

RUN mkdir -p /app/uploads /tmp/uploads

EXPOSE 3000

CMD ["node", "server.js"]
