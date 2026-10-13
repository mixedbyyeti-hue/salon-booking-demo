FROM oven/bun:1

USER root
WORKDIR /app

COPY server.ts sms.ts db.ts ./
COPY config ./config
COPY public ./public

# The oven/bun image runs as the non-root `bun` user. `/app` is root-owned,
# so create a writable SQLite directory and hand the tree to `bun`.
# db.ts also creates `data/` when the process starts.
RUN mkdir -p /app/data && chown -R bun:bun /app

USER bun
ENV TZ=America/New_York

EXPOSE 10000

CMD ["bun", "server.ts"]
