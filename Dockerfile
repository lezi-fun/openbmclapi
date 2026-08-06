ARG BASE_IMAGE=node:26.5.0-bookworm-slim
ARG BUN_IMAGE=oven/bun:1.3.14
FROM $BUN_IMAGE AS bun
FROM $BASE_IMAGE AS dependencies

WORKDIR /opt/openbmclapi
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package-lock.json package.json ./
RUN bun install

FROM dependencies AS install

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM dependencies AS modules
RUN rm -rf node_modules && bun install --production

FROM $BASE_IMAGE AS build

RUN apt-get update && \
    apt-get install -y nginx tini && \
    rm -rf /var/lib/apt/lists/*

ARG USER=root

RUN chown -R $USER /var/log/nginx /var/lib/nginx

USER $USER

WORKDIR /opt/openbmclapi
COPY --from=modules /opt/openbmclapi/node_modules ./node_modules
COPY --from=install /opt/openbmclapi/dist ./dist
COPY nginx/ /opt/openbmclapi/nginx
COPY package.json ./


ENV CLUSTER_PORT=4000
EXPOSE $CLUSTER_PORT
VOLUME /opt/openbmclapi/cache
CMD ["tini", "--", "node", "--enable-source-maps", "dist/index.js"]
