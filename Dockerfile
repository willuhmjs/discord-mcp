# Build stage: install deps and compile TypeScript.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: production deps + compiled output only.
FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
# In containers the MCP endpoint is usually reached from another container,
# so bind all interfaces. Put it behind a private network or a reverse proxy.
ENV HOST=0.0.0.0
ENV PORT=8085
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8085
CMD ["node", "dist/index.js"]
