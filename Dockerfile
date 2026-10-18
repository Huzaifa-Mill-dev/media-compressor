# syntax=docker/dockerfile:1
# ---- build: compile the server and the static site -------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json engine/package-lock.json engine/
COPY web/package.json web/package-lock.json web/
RUN npm ci && npm --prefix engine ci && npm --prefix web ci
COPY . .
RUN npm run build:server && npm --prefix web run build && npm prune --omit=dev

# ---- runtime: Node + the native tools the fallback API shells out to ------------------------------
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ghostscript qpdf util-linux libheif-examples \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      python3 python3-fonttools python3-brotli \
      fonts-dejavu fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/scripts ./server/scripts
COPY --from=build /app/shared ./shared
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=384", "server/dist/index.js"]
