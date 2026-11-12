# syntax=docker/dockerfile:1
# Multi-stage so server/view-only edits skip map build and prod npm install.

FROM node:22-alpine AS map-build
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

FROM node:22-alpine AS prod-deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /usr/src/app
RUN apk add --no-cache ca-certificates && update-ca-certificates

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
