# syntax=docker/dockerfile:1
# Multi-stage so server/view-only edits skip map build and prod npm install.

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS map-build
WORKDIR /usr/src/app
RUN apk add --no-cache ca-certificates && update-ca-certificates
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY client/map ./client/map
COPY scripts/generate-map-app.mjs scripts/build-map.mjs ./scripts/
ENV NODE_ENV=production
RUN npm run build:map

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS prod-deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /usr/src/app
# Patch base-image packages, and drop npm/corepack: nothing in the container runs them
# (deps come from the prod-deps stage; the CMD below is plain node).
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates && update-ca-certificates \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY --from=map-build /usr/src/app/public/dist ./public/dist
COPY --from=map-build /usr/src/app/public/vendor/maplibre-gl ./public/vendor/maplibre-gl
# App sources last. .dockerignore omits generated dist/vendor so the
# map-build artifacts above are preserved when only server files change.
COPY . .

EXPOSE 3000

# exec so SIGTERM reaches Node (npm start prints a fake "command failed" on recreate).
CMD ["sh", "-c", "node scripts/ensure-map-built.mjs && exec node --use-system-ca server.js"]
