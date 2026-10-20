# Runs `laserpdf --mcp` (stdio MCP server) on Linux, for MCP directories that start servers in a container.
# The desktop app needs a display even though MCP mode never shows a window, so a virtual one (Xvfb) is
# started first. Its output goes to /dev/null: stdout belongs to the MCP protocol.
FROM ubuntu:22.04

ARG VERSION=1.1.0
ARG DEB_URL=https://github.com/BatuhanCakmakk/laserpdf/releases/download/v${VERSION}/LaserPDF_${VERSION}_amd64.deb
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xvfb \
 && curl -fsSL -o /tmp/laserpdf.deb "${DEB_URL}" \
 && apt-get install -y --no-install-recommends /tmp/laserpdf.deb \
 && rm -rf /tmp/laserpdf.deb /var/lib/apt/lists/*

# No GPU in a container: software rendering only. No accessibility bus either, so GTK should not wait for one.
ENV WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    NO_AT_BRIDGE=1

ENTRYPOINT ["/bin/sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 & export DISPLAY=:99; i=0; while [ ! -e /tmp/.X11-unix/X99 ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; exec laserpdf --mcp"]
