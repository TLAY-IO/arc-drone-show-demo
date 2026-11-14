FROM node:25-alpine

WORKDIR /app

# Install from the lockfile, not from the spec (same reasoning as the workers).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

CMD ["node", "index.js"]
