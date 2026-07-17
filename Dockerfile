# Fallback Dockerfile — used if Railway's nixpacks builder ever fails.
# Runs the exact same server/server.js entrypoint on Node 20.
FROM node:20-alpine

WORKDIR /app

# Copy manifests first for layer caching
COPY server/package.json server/package-lock.json* ./server/

# Prod deps only — Playwright + Python subprocess routes are LOCAL_ONLY and
# guarded off in the cloud, so no need to install browsers or the Python venv.
RUN cd server && npm ci --omit=dev || cd server && npm install --omit=dev

# Copy the rest of the repo (server + dashboard static assets)
COPY . .

ENV NODE_ENV=production
ENV PORT=3737

EXPOSE 3737

CMD ["node", "server/server.js"]
