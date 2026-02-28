# Stage 1: Build toll-booth from source
FROM node:22-slim AS toll-booth-build
WORKDIR /toll-booth
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm pack

# Stage 2: Build the routing proxy
FROM node:22-slim
WORKDIR /app
COPY --from=toll-booth-build /toll-booth/toll-booth-0.1.0.tgz ./
COPY examples/valhalla-proxy/package.json ./
RUN sed -i 's|"file:../../"|"file:./toll-booth-0.1.0.tgz"|' package.json
RUN npm install --production
COPY examples/valhalla-proxy/server.ts ./
EXPOSE 3000
CMD ["node", "--loader", "tsx", "server.ts"]
