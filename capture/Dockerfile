FROM node:22-bookworm-slim

# Distro Chromium + ffmpeg + fonts is the smallest reliable combo for
# headless capture: Playwright's official image is ~2 GB and Alpine is
# unsupported by both Puppeteer and Playwright. ffmpeg is needed twice
# over — Puppeteer's page.screencast() shells out to it to encode the
# webm recording, and capture.js invokes it directly for the GIF
# transcode (palettegen/paletteuse).
#
# Inter is the capture's sans-serif (capture/fonts.conf says why): the
# platform sets its text in the reader's system face, which this image does
# not have, and the Liberation/DejaVu fallback made every capture look like
# a different product from the one on a phone.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg ca-certificates \
    fonts-inter fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
COPY capture/fonts.conf /etc/fonts/local.conf
RUN fc-cache -f

WORKDIR /app

# puppeteer-core only — the browser comes from the distro package above,
# so no Chromium download at npm-install time.
RUN npm install puppeteer-core@^23 \
  && chown -R node:node /app

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY capture/capture.js /app/capture.js
COPY evidence/hosted-app-fixture.js /app/evidence-hosted-app-fixture.js
COPY worker/session-bootstrap.js /worker/session-bootstrap.js
COPY worker/evidence-hosted-origins.js /worker/evidence-hosted-origins.js
COPY worker/evidence-hosted-app-contract.js /worker/evidence-hosted-app-contract.js

# This image also serves the short-lived hosted-app evidence fixture through
# the ordinary Kubernetes app runtime. That runtime enforces runAsNonRoot
# without assigning a UID, so kubelet must be able to verify a numeric image
# user before the container starts. UID/GID 1000 are the official node
# image's node account, preserving the same files and permissions as before.
USER 1000:1000

# One-shot: reads BEFORE_URL / AFTER_URL (either may be empty) from env,
# emits sentinel-framed base64 artifacts on stdout, exits 0. The platform
# (src/services/visuals.js) runs this with `docker run --rm` and parses
# stdout — see that file for the protocol.
CMD ["node", "/app/capture.js"]
