# Slotify

> UofTHacks 13 Winner - MLH Best Use of ElevenLabs

Authors: James Weng, Ryan Li, David Yang

Devpost: https://devpost.com/software/slotify-avmxe8

Pipeline: Upload a product name and audio file with speech → ElevenLabs clones voice(s) and generates a human-like ad read → Call OpenAI API to generate ad text → the system finds the optimal insertion point based on syntactic + semantic context, stitching the ad into the final audio.

[Video Demo](https://www.youtube.com/watch?v=S4m1lpipni0)

## Core features
- User input for podcast audio and product name - product details are optional
- AI-recommended insertion timestamps using semantic + syntactic analysis
- ElevenLabs TTS for realistic sponsor reads (single speaker or multi-way conversation)
- Preview insertions before rendering final output
- Export monetized episodes with loudness matching + crossfades

## Tech stack
- Frontend: React + TypeScript + Vite, plain CSS with CSS custom properties (Syne + DM Mono + DM Sans fonts)
- Backend API: Node.js + Express
- Audio pipeline: Python (pydub, librosa, pyloudnorm)
- AI services: OpenAI (ad generation + placement), ElevenLabs (TTS/voice cloning)
- Media tools: ffmpeg/ffprobe
- Background jobs: Redis + BullMQ (queues the two-speaker `/ad/insert` pipeline)
- Containers: Docker + docker-compose (backend, worker, frontend, redis)

## Project structure
```text
.
├── README.md
├── docker-compose.yml    # redis + backend + worker + frontend
├── .env.example
├── backend/              # Node API + Python ad_inserter pipeline
│   ├── ad_inserter/
│   ├── audio_tests/
│   ├── jobs/adInsertJob.mjs   # shared pipeline logic (used by worker.mjs)
│   ├── lib/                   # redis.mjs, queue.mjs, jobStorage.mjs
│   ├── index.mjs               # API (enqueues /ad/insert jobs)
│   ├── worker.mjs              # BullMQ consumer for the ad-insert queue
│   ├── Dockerfile
│   ├── package.json
│   └── requirements.txt
├── frontend/             # React UI
│   ├── src/
│   ├── index.html
│   ├── Dockerfile
│   ├── package.json
│   └── vite.config.ts
├── docs/
└── venv/
```

## Local deployment
### Prereqs
- Node.js (for `frontend/` and `backend/`)
- Python (for `backend/ad_inserter`)
- `ffmpeg` + `ffprobe`

### 1) Backend API
```bash
cd backend
npm install
pip install -r requirements.txt
```

Set env vars (examples):
```bash
export ELEVENLABS_API_KEY="..."
export OPENAI_API_KEY="..."
```

Run the API:
```bash
npm run dev
```

The API listens on `http://localhost:3001`.

### 2) Frontend
```bash
cd frontend
npm install
npm run dev
```

The UI runs on `http://localhost:5173` and calls the backend.

### 3) Background worker (for `/ad/insert`)

The two-speaker `POST /ad/insert` pipeline (diarization + LLM copywriting + ElevenLabs TTS + ffmpeg mix) can take well over a minute, so `index.mjs` queues it on Redis via [BullMQ](https://docs.bullmq.io/) instead of blocking the HTTP request, and `worker.mjs` is the process that actually consumes it:
```bash
npm run worker
```
This needs a Redis instance reachable at `REDIS_URL` (defaults to `redis://localhost:6379`). Without it, `/ad/insert` requests still get queued and return a `jobId`, they just sit unprocessed until a worker is running — every other route (`/api/clone`, `/api/tts`, `/api/merge`, `/api/insert-sections`, `/api/generate`, which is what the frontend actually calls today) responds synchronously and doesn't need Redis at all.

### Or run everything with Docker

`docker compose up --build` runs the whole stack without installing Node/Python/ffmpeg locally. Copy `.env.example` to `.env` first and fill in your API keys.

## Ad Inserter backend module
- `__init__.py` exposes the package modules (analysis, llm, mix) and version
- `analysis.py` handles audio analysis: ffmpeg check, loading/standardizing audio, silence-based candidate detection for podcasts, beat/RMS analysis for songs, optional Whisper transcription, and building candidate payloads
- `analyze_cli.py` exposes a CLI helper that runs analysis and returns JSON for the Node API
- `cli.py` provides the single-speaker CLI workflow: parse args, pick candidates, call LLM to write promo/choose insertion, loudness match + room tone + crossfade, and export output (plus debug artifacts)
- `insert_ad.py` handles two-speaker insertion (A/B/DUO), optional diarization, and optional voice cloning
- `llm.py` builds the prompt and calls OpenAI to generate promo text and choose insertion index; parses JSON response into `LLMResult`
- `mix.py` does audio mixing utilities: LUFS measurement, loudness matching, looping room tone, ducking, crossfade insertion, and context window extraction
- `tts.py` builds sponsor reads with ElevenLabs (single or multi-statement blocks)

### How is insertion point chosen?
Semantic context:
- Uses Whisper locally (if installed) to transcribe short context windows around candidate insertion points before evaluating topic transitions and sentence boundaries
- If Whisper is not available, fall back to silence-based insertion

Rhythmic/syntactic context:
- Uses librosa to estimate tempo and beat times
- Finds low-energy (RMS) valleys, snaps to the nearest beat, and inserts the promo there

### Test without deploying full app

Run from the `backend/` directory so `python -m ad_inserter.cli` can find the package.

Podcast example:
```bash
python -m ad_inserter.cli \
  --main path/to/main.mp3 \
  --promo-audio path/to/promo.wav \
  --product-name "Sparrow Notes" \
  --product-desc "A calmer note-taking app for busy teams" \
  --product-url "https://sparrow.example" \
  --mode podcast \
  --out output.mp3 \
  --debug-dir debug
```

Song example:
```bash
python -m ad_inserter.cli \
  --main path/to/song.mp3 \
  --promo-audio path/to/promo.mp3 \
  --product-name "Pulse Water" \
  --product-desc "Electrolytes without the sugar crash" \
  --mode song \
  --out song_with_ad.mp3
```

## Two-speaker ad insertion
This feature inserts an AI-written ad into a two-person conversation. It can speak as Speaker A, Speaker B, or a short back-and-forth.

### Required env vars
- `OPENAI_API_KEY` for ad script generation (unless `--llm-provider none`)
- `ELEVENLABS_API_KEY` for TTS
- `ELEVENLABS_VOICE_ID_A` and `ELEVENLABS_VOICE_ID_B` for speaker mapping, or set `ELEVENLABS_DEFAULT_VOICE_ID` as a fallback

Optional diarization (enables DUO mode and voice cloning):
- Install `pyannote.audio` separately
- Set `HUGGINGFACE_TOKEN` (or `PYANNOTE_TOKEN`) for model access

### CLI example
```bash
python -m ad_inserter.insert_ad \
  --input path/to/conversation.mp3 \
  --product-name "Notion" \
  --product-blurb "AI-powered productivity workspace" \
  --ad-style casual \
  --ad-mode DUO \
  --out out.mp3
```

Optional voice cloning (requires diarization + ElevenLabs API key):
```bash
python -m ad_inserter.insert_ad \
  --input path/to/conversation.mp3 \
  --product-name "Notion" \
  --product-blurb "AI-powered productivity workspace" \
  --ad-style casual \
  --ad-mode A_ONLY \
  --clone-voices \
  --out out.mp3
```

### API example
`POST /ad/insert` runs asynchronously on a Redis-backed BullMQ queue since the full pipeline can take well over a minute: `index.mjs` writes the upload to a shared volume and enqueues a job, `worker.mjs` consumes it and writes the result back, and the request returns a `jobId` immediately instead of streaming audio back directly. Poll `GET /api/jobs/:id` for status and fetch `GET /api/jobs/:id/result` once it reports `"completed"`:

```bash
curl -X POST http://localhost:3001/ad/insert \
  -F "audio=@path/to/conversation.mp3" \
  -F "productName=Notion" \
  -F "productBlurb=AI-powered productivity workspace" \
  -F "adStyle=casual" \
  -F "adMode=DUO"
# => {"jobId":"...", "statusUrl":"/api/jobs/...", "resultUrl":"/api/jobs/.../result"}

# Poll until state is "completed":
curl http://localhost:3001/api/jobs/<jobId>

# Then download the finished audio:
curl http://localhost:3001/api/jobs/<jobId>/result --output out.mp3
```

## LLM configuration
- `--llm-provider openai` (default `openai`)
- Set `OPENAI_API_KEY` in your environment
