# syntax=docker/dockerfile:1.7
# One Dockerfile, one build target per service:
#   docker build --target search      search gateway (one port)
#   docker build --target browser     browser sessions + viewer
#   docker build --target brave-mcp   official Brave Search MCP
#   docker build --target dsh         DSH web with the panel plugin

############################ search gateway ############################

FROM node:24-bookworm-slim AS search-build
ENV PNPM_VERSION=11.28.5
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim AS search
ENV PNPM_VERSION=11.28.5 \
    NODE_ENV=production \
    SEARCH_HOST=0.0.0.0 \
    SEARCH_PORT=8787 \
    SEARCH_CONFIG_PATH=/data/search-config.json
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=search-build /app/dist ./dist
RUN mkdir -p /data
EXPOSE 8787
CMD ["node", "dist/search-server.js"]

############################ browser service ############################

FROM node:24-bookworm-slim AS browser
ENV CHROME_VERSION=156.0.8078.47 \
    PNPM_VERSION=11.28.5
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6 libx11-xcb1 \
      libdbus-1-3 libexpat1 libglib2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/chrome-for-testing/chrome/linux-${CHROME_VERSION}/chrome-linux64 \
    && cd /tmp \
    && curl -fsSL -o chrome-linux64.zip \
       "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
    && unzip -q chrome-linux64.zip \
    && mv chrome-linux64/* /opt/chrome-for-testing/chrome/linux-${CHROME_VERSION}/chrome-linux64/ \
    && rm -rf chrome-linux64 chrome-linux64.zip
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build
ENV BROWSER_HOST=127.0.0.1 \
    BROWSER_PORT=8790 \
    BROWSER_VIEWER_HOST=127.0.0.1 \
    BROWSER_VIEWER_PORT=8791 \
    BROWSER_HEADLESS=true \
    BROWSER_PROFILE_ROOT=/data/sessions \
    BROWSER_ARTIFACT_ROOT=/data/artifacts \
    BROWSER_IDLE_TIMEOUT_MS=1800000
VOLUME ["/data"]
EXPOSE 8790 8791
CMD ["node", "dist/browser-server.js"]

############################ brave MCP service ############################

FROM node:24-bookworm-slim AS brave-mcp
RUN npm install -g @brave/brave-search-mcp-server
COPY docker/brave-mcp-entrypoint.sh /usr/local/bin/brave-mcp-entrypoint
RUN chmod +x /usr/local/bin/brave-mcp-entrypoint
ENV BRAVE_MCP_TRANSPORT=http \
    BRAVE_MCP_HOST=0.0.0.0 \
    BRAVE_MCP_PORT=8000 \
    BRAVE_MCP_STATELESS=true
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/brave-mcp-entrypoint"]

############################ DSH web ############################

FROM node:24-bookworm-slim AS dsh
ENV DSH_VERSION=0.2.1-rc.2 \
    PNPM_VERSION=11.28.5
RUN npm install -g pnpm@${PNPM_VERSION} \
    && npm install -g @deepseek-ai/dsh@${DSH_VERSION}
COPY panel /opt/dsh-browser-runtime/panel
COPY config /opt/dsh-browser-runtime/config
COPY docker/dsh-entrypoint.sh /usr/local/bin/dsh-entrypoint
RUN chmod +x /usr/local/bin/dsh-entrypoint
ENV DSH_HOST=0.0.0.0 \
    DSH_PORT=3090 \
    DSH_PROFILE=web \
    DSH_HOME=/dsh-home \
    DSH_BROWSER_API_URL=http://browser:8790 \
    DSH_BROWSER_VIEWER_URL=http://browser:8791 \
    DSH_SEARCH_URL=http://search-gateway:8787
EXPOSE 3090
VOLUME ["/dsh-home"]
ENTRYPOINT ["/usr/local/bin/dsh-entrypoint"]
