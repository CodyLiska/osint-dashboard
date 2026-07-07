FROM node:22-alpine

WORKDIR /app

# No dependencies to install: the app uses only Node built-ins and loads
# MapLibre GL / deck.gl from CDNs in the browser. Copy source directly.
COPY . .

# Bind to all interfaces inside the container so the Docker bridge can reach it.
# The published host port is controlled by docker-compose (WEB_PORT).
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

CMD ["node", "server.js"]
