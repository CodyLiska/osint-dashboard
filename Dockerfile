FROM node:22-alpine

WORKDIR /app

# No dependencies to install: the app uses only Node built-ins and loads
# MapLibre GL / deck.gl from CDNs in the browser. Copy source directly, owned by
# the unprivileged `node` user (built into the base image).
COPY --chown=node:node . .

# Bind to all interfaces inside the container so the Docker bridge can reach it.
# The published host port is controlled by docker-compose (WEB_PORT).
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

# Drop root: the app writes nothing to disk (cache is in-memory) and binds a
# non-privileged port, so it runs fine as the unprivileged built-in `node` user.
USER node

CMD ["node", "server.js"]
