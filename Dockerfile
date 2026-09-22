FROM node:24-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data && useradd --create-home --uid 1001 appuser \
  && chown -R appuser:appuser /app /data
USER appuser

ENV GIT_WORKDIR=/data/git-workdir
ENV DB_PATH=/data/pr-queue.db

VOLUME ["/data"]

CMD ["node", "dist/index.js"]
