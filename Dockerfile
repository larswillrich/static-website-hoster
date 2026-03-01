FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/

# Generate OG image PNG from SVG at build time
RUN node scripts/generate-og.js

RUN mkdir -p /app/uploads /tmp/uploads

EXPOSE 3000

CMD ["node", "server.js"]
