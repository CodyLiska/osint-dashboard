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

# Writable, node-owned data dir for optional historical persistence
# (OSIRIS_DB_PATH). Created here as root so a fresh named volume mounted at
# /app/data inherits node:node ownership on first mount; without it the
# unprivileged user hits EACCES and history silently stays empty. Persistence is
# still fully optional — unset OSIRIS_DB_PATH and nothing is written here.
RUN mkdir -p /app/data && chown node:node /app/data

# Drop root: the app writes nothing to disk unless persistence is enabled (then
# only to /app/data, owned above) and binds a non-privileged port, so it runs
# fine as the unprivileged built-in `node` user.
USER node

# --disable-warning=ExperimentalWarning silences the node:sqlite experimental
# notice (used only when persistence is enabled) while keeping other warnings.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
