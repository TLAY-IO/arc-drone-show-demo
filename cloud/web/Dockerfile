FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
# NEXT_PUBLIC_* values are inlined at BUILD time — they must arrive here as
# build args (docker-compose passes them from .env). Changing them later
# requires `docker compose build web`, not just a restart.
ARG NEXT_PUBLIC_DEMO_SELLER_EOA
ARG NEXT_PUBLIC_DEMO_DEVICE_ID
ARG NEXT_PUBLIC_ARC_EXPLORER
ENV NEXT_PUBLIC_DEMO_SELLER_EOA=$NEXT_PUBLIC_DEMO_SELLER_EOA \
    NEXT_PUBLIC_DEMO_DEVICE_ID=$NEXT_PUBLIC_DEMO_DEVICE_ID \
    NEXT_PUBLIC_ARC_EXPLORER=$NEXT_PUBLIC_ARC_EXPLORER
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE 3000
CMD ["npm", "start"]
