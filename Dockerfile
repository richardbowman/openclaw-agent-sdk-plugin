FROM debian:bookworm-slim

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install the claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install OpenClaw globally (latest)
RUN npm install -g openclaw

# Copy plugin project files
RUN mkdir -p /config/claude-sdk-proxy
COPY proxy.mjs              /config/claude-sdk-proxy/proxy.mjs
COPY index.mjs              /config/claude-sdk-proxy/index.mjs
COPY package.json           /config/claude-sdk-proxy/package.json
COPY openclaw.plugin.json   /config/claude-sdk-proxy/openclaw.plugin.json

# Install plugin dependencies
RUN cd /config/claude-sdk-proxy && npm install

WORKDIR /config/claude-sdk-proxy

CMD ["node", "--version"]
