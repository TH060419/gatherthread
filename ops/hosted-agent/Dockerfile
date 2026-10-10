# Build this image in a reviewed CI pipeline, inspect its digest, and set
# GATHERTHREAD_HOSTED_AGENT_IMAGE to its immutable local image ID or registry digest. Runtime containers
# receive no provider credential and have no general network interface.
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends socat git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global opencode-ai@1.18.32 && opencode --version
# A private Git-less build uses umask 077. Public runtime modules still need
# deterministic read access for the non-root image user, independent of source modes.
COPY --chmod=0644 ops/hosted-agent/entrypoint.mjs /usr/local/lib/gatherthread-hosted-entrypoint.mjs
COPY --chmod=0555 ops/hosted-agent/cpuset-entrypoint.mjs /usr/local/lib/gatherthread-hosted-cpuset-entrypoint.mjs
COPY --chmod=0644 ops/hosted-agent/resource-check.mjs /usr/local/lib/resource-check.mjs
COPY --chmod=0644 ops/hosted-agent/public-answer.mjs /usr/local/lib/public-answer.mjs
COPY --chmod=0644 ops/hosted-agent/opencode-session.mjs /usr/local/lib/opencode-session.mjs
COPY --chmod=0644 ops/hosted-agent/npm-setup.mjs /usr/local/lib/npm-setup.mjs
RUN groupadd --gid 10001 agent && useradd --uid 10001 --gid 10001 --home-dir /home/agent agent
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/usr/local/lib/gatherthread-hosted-entrypoint.mjs"]
