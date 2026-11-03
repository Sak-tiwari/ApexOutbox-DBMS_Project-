# One image: the API (which also serves the built web app) plus the one-shot migration command.
# ---- build: compile server and web ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build -w server && npm run build -w web

# ---- runtime: production dependencies only, non-root ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000 WEB_DIST_DIR=/app/web/dist INVOICE_STORAGE_DIR=/data/invoices
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
COPY THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /data/invoices && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are a separate step: docker compose run --rm migrate
CMD ["node", "server/dist/server.js"]
