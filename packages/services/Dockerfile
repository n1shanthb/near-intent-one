FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* ./
COPY packages ./packages
COPY scripts/lib ./scripts/lib
RUN npm install --omit=dev || true
ENV NODE_ENV=production
ENV GATE_I_HOST=0.0.0.0
ENV GATE_I_PORT=8787
ENV NEAR_NETWORK=testnet
EXPOSE 8787
# Mount secrets at runtime:
#   -v $PWD/.near-credentials:/app/.near-credentials:ro
#   -v gate-i-data:/app/.gate-i-data
CMD ["node", "packages/services/api-server.mjs"]
