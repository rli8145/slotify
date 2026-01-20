# Slotify backend: Node/Express API + Python ad_inserter pipeline (ffmpeg,
# librosa, pydub, optional Whisper/pyannote). One image, two entrypoints:
#   - `node index.mjs`  (the API, default CMD)
#   - `node worker.mjs` (the BullMQ queue worker, set via docker-compose `command:`)
FROM node:20-bookworm-slim

# ffmpeg/ffprobe for audio mixing, python3 for the ad_inserter package.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON_BIN=python3

WORKDIR /app

# Install Node deps first so this layer is cached unless package.json changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Python deps for the ad_inserter package (Debian marks the system
# interpreter externally-managed; this container is single-purpose so that's fine).
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# App source last, so editing code doesn't invalidate the dependency layers above.
COPY . .

EXPOSE 3001

CMD ["node", "index.mjs"]
