# One image, one process, one port.
#
# The game server also serves the built client, so there is no second container, no reverse
# proxy in front of two origins, and no CORS to configure. That matters more than it sounds:
# the websocket and the page arrive from the same host, which is what makes a single tunnel or
# a single PaaS service enough to play on.
FROM node:22-slim AS build

WORKDIR /app

# Manifests first, so a change to game code does not reinstall the world.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/rounds/package.json packages/rounds/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build:web

# ---------------------------------------------------------------------------------------

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/rounds/package.json packages/rounds/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev

# The server runs its TypeScript through tsx rather than a compiled bundle, because the
# workspace packages export .ts directly. tsx is a runtime dependency of the server for
# exactly this reason.
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY content/ content/
COPY --from=build /app/apps/web/dist apps/web/dist

# Not root. The process needs to read seed JSON and nothing else.
USER node

EXPOSE 3001
ENV PORT=3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "--workspace=@game/server"]
