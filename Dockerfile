# The intake API (and the `migrate` one-shot service) for docker-compose.yml.
# Build stage: compile src/ to dist/ with TypeScript 7 (npm run build).
# Runtime stage: production dependencies and dist/ only, run as the non-root `node` user.
# Pinned to an exact Node 24 release on a fixed Alpine version; Dependabot (docker) keeps it current.

FROM node:24.22.3-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.3-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
