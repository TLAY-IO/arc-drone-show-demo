FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js burn-intent.js single-instance-guard.js ./
COPY scripts ./scripts

# Operator key is NOT baked into the image — mount it read-only at runtime
# (see docker-compose.yml) and point OPERATOR_KEY_PATH at the mount.
CMD ["node", "index.js"]
