FROM node:20-alpine

WORKDIR /app

# @tlay/hashanchor-client is a github: (git) dependency and node:20-alpine
# ships without git, so npm install would fail with `spawn git ENOENT`.
RUN apk add --no-cache git
# Install from the lockfile, not from the spec: `npm install` would re-resolve
# `#v1.0.2` at build time, so the tag — not this repo — would decide which
# SDK commit ships. The pin only means something if the build reads the lock.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

CMD ["node", "index.js"]
