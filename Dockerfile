FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/

# Fonts for the text in og-image.svg. Alpine ships without any, and sharp then renders every
# <text> element as nothing — the link preview would be an empty dark rectangle. fontconfig
# substitutes Liberation Sans/Mono for the Helvetica/Arial and monospace families the SVG asks for.
RUN apk add --no-cache font-liberation

# Generate the OG image and the square icons from the SVGs at build time
RUN node scripts/generate-og.js

RUN mkdir -p /app/uploads /tmp/uploads /app/data/analytics

EXPOSE 3000

CMD ["node", "server.js"]
