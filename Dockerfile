# Self-host the notion-chat-proxy Worker as a plain Node server (no Cloudflare
# Workers platform). server.js adapts the worker handler to Node HTTP + an
# in-memory KV. Set env vars (see README) on the host (Railley / docker run -e).
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src/ ./src/

EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
