# Two stages because koffi (the FFI library behind the harness's subprocess and
# sandbox plugins) ships source only: installing it compiles with CMake, and a
# toolchain has no business in the runtime image.
FROM node:24-slim AS harness

ARG DSH_VERSION=0.1.1-rc.2
ENV DSH_HOME=/dsh-home

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates cmake g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

# npm 11 defers install scripts by default, which silently leaves koffi without
# its native module; the harness then fails to load subprocess-local and
# sandbox-local. Approve them explicitly rather than discovering it at runtime.
RUN npm install-scripts approve --all --no-allow-scripts-pin || true
RUN npm install -g --foreground-scripts "@deepseek-ai/dsh@${DSH_VERSION}"

# `dsh plugin` forwards to pnpm inside the profile directory.
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY plugins/dsh-session-resume /opt/dsh-plugins/dsh-session-resume

# -w because dsh writes a pnpm-workspace.yaml into the profile, which makes the
# profile directory a workspace root that pnpm refuses to add to implicitly.
# dsh-sdk-protocol is a peer of the jsonrpc server and the one peer the
# installation does not already carry, so the profile's flat node_modules
# fallback cannot resolve it. Every other peer comes from dsh-base.
RUN dsh plugin --profile dbtcraft add -w \
      "@deepseek-ai/dsh-sdk-jsonrpc-server@0.0.1-rc.5" \
      "@deepseek-ai/dsh-sdk-protocol@0.0.1-rc.5" \
      "link:/opt/dsh-plugins/dsh-session-resume"

COPY profile/cordis.patch.yml ${DSH_HOME}/profiles/dbtcraft/cordis.patch.yml

# Fail the build, not the first request, on a patch that names a row the
# composition does not have.
RUN dsh --profile dbtcraft --dump-config > /dev/null


FROM node:24-slim AS runtime

ENV DSH_HOME=/dsh-home \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

# socat is for the optional `dsh web` surface: that server refuses to bind
# 0.0.0.0 (it would publish remote code execution to the network), so reaching
# it from outside its own container needs a forwarder in front of its loopback.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-venv socat \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

COPY --from=harness /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=harness /dsh-home /dsh-home
# The profile holds a pnpm link: to this path, so the link target has to exist
# here too or the plugin row fails to import.
COPY --from=harness /opt/dsh-plugins /opt/dsh-plugins

# Recreate the launcher as a symlink rather than copying it: COPY dereferences
# symlinks, and a real file at /usr/local/bin/dsh makes Node resolve the
# harness's own packages relative to /usr/local/bin, where they are not.
RUN ln -s ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh

WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
COPY dbt_mcp ./dbt_mcp
RUN pip install --no-cache-dir .

# The harness writes model files onto the volume dbt-runner reads, and writes
# them owner-only. Share dbt-runner's uid (appuser, 1000) or dbt cannot read the
# model the agent just created.
# uid 1000 in node:24-slim is the `node` user, which is the uid dbt-runner's
# appuser also has - reuse it rather than creating a second one.
RUN chown -R node:node /dsh-home /opt/venv \
    && chmod 700 /dsh-home
USER node

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8090/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
