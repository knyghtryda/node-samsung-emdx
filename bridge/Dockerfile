# Build from the repository root (the bridge uses ../lib):
#   docker build -f bridge/Dockerfile -t samsung-emdx-bridge .
FROM node:22-alpine

# tzdata: the rotation schedule and the display's wake alarm are local time
RUN apk add --no-cache tzdata

WORKDIR /app
COPY bridge/package*.json bridge/
RUN cd bridge && npm ci --omit=dev && npm cache clean --force

COPY lib/ lib/
COPY bridge/ bridge/

ENV DATA_DIR=/data \
    BRIDGE_PORT=8080
VOLUME /data
EXPOSE 8080

WORKDIR /app/bridge
CMD ["node", "index.mjs"]
