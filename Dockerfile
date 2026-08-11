# ---- build stage ----
# better-sqlite3 compiles a native module, so the builder needs a
# toolchain; the runtime stage copies the pruned node_modules instead
# of reinstalling (no toolchain in the final image).
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Run as the built-in non-root node user; /data holds the SQLite file.
RUN mkdir /data && chown node:node /data
USER node
ENV DB_PATH=/data/scores.db

CMD ["node", "dist/index.js"]
