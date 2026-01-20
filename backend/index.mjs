import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { adInsertQueue } from "./lib/queue.mjs";
import { createJobDir, jobDir } from "./lib/jobStorage.mjs";
import {
  cacheKey,
  cacheGetBuffer,
  cacheSetBuffer,
  cacheGetText,
  cacheSetText,
} from "./lib/cache.mjs";

// Same (voiceId, text) almost always recurs within a demo/testing session —
// caching the ElevenLabs audio and OpenAI-generated copy saves real ElevenLabs
// minutes/OpenAI tokens and turns a repeat request into a Redis GET.
const TTS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // audio for a given text+voice never changes
const STATEMENT_CACHE_TTL_SECONDS = 24 * 60 * 60;

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);

// Check for ElevenLabs API key
if (!process.env.ELEVENLABS_API_KEY) {
  console.warn(
    "Warning: ELEVENLABS_API_KEY not set. Voice cloning and TTS will fail.",
  );
}

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});
const upload = multer({ storage: multer.memoryStorage() });

const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS blocked"));
    },
  }),
);
app.use(express.json({ limit: "2mb" }));

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    elevenlabsConfigured: !!process.env.ELEVENLABS_API_KEY,
  });
});

app.post("/api/clone", upload.array("files"), async (req, res) => {
  const files = req.files ?? [];
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "No audio files uploaded." });
    return;
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    res.status(500).json({
      error:
        "ELEVENLABS_API_KEY not configured. Please set it in your environment variables.",
    });
    return;
  }

  const name = req.body?.name?.toString()?.trim() || "My Voice Clone";
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "voice-clone-"),
  );
  const tempPaths = [];

  try {
    for (const file of files) {
      const safeName = path.basename(file.originalname || "sample.wav");
      const tempPath = path.join(
        tempDir,
        `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`,
      );
      await fs.promises.writeFile(tempPath, file.buffer);
      tempPaths.push(tempPath);
    }

    const streams = tempPaths.map((tempPath) =>
      fs.createReadStream(tempPath),
    );
    const voice = await elevenlabs.voices.ivc.create({
      name,
      files: streams,
    });

    res.json({ voiceId: voice.voiceId });
  } catch (error) {
    console.error("Clone error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Clone failed.";
    res.status(500).json({
      error: errorMessage,
    });
  } finally {
    await Promise.all(
      tempPaths.map((tempPath) =>
        fs.promises.unlink(tempPath).catch(() => undefined),
      ),
    );
    await fs.promises.rmdir(tempDir).catch(() => undefined);
  }
});

const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });
  });

const getAudioDuration = async (filePath) =>
  new Promise((resolve, reject) => {
    const process = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        const duration = Number.parseFloat(stdout.trim());
        resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
      } else {
        reject(new Error(stderr || `ffprobe exited with code ${code}`));
      }
    });
  });

const streamToBuffer = async (webStream) => {
  const chunks = [];
  const nodeStream = Readable.fromWeb(webStream);
  for await (const chunk of nodeStream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

// Wraps elevenlabs.textToSpeech.convert with a Redis cache keyed on the
// exact (voiceId, text, modelId, outputFormat) tuple, since that's what
// determines the audio bytes. Every call site buffers the result anyway
// (to write it to disk or concat it), so caching costs nothing extra on a
// miss and turns a repeat statement into a single Redis GET on a hit.
const synthesizeSpeech = async ({ voiceId, text, modelId, outputFormat }) => {
  const resolvedModelId = modelId ?? "eleven_multilingual_v2";
  const resolvedOutputFormat = outputFormat ?? "mp3_44100_128";
  const key = cacheKey("tts", {
    voiceId,
    text,
    modelId: resolvedModelId,
    outputFormat: resolvedOutputFormat,
  });

  const cached = await cacheGetBuffer(key);
  if (cached) return cached;

  const audio = await elevenlabs.textToSpeech.convert(voiceId, {
    text,
    modelId: resolvedModelId,
    outputFormat: resolvedOutputFormat,
  });
  const buffer = await streamToBuffer(audio);
  await cacheSetBuffer(key, buffer, TTS_CACHE_TTL_SECONDS);
  return buffer;
};

const parseJsonField = (value) => {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const normalizeStatements = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (entry == null ? "" : String(entry).trim()))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = parseJsonField(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => (entry == null ? "" : String(entry).trim()))
        .filter(Boolean);
    }
    return [trimmed];
  }
  return [];
};

const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

const endsWithSentenceBoundary = (text) =>
  /[.!?]["')\]]?\s*$/.test(String(text ?? "").trim());

const mergeCandidates = (base, extra, minGapMs = 400) => {
  const combined = [...base, ...extra].filter(Boolean);
  combined.sort((a, b) => a.ms - b.ms);
  const merged = [];
  for (const cand of combined) {
    const last = merged[merged.length - 1];
    if (!last || Math.abs(cand.ms - last.ms) > minGapMs) {
      merged.push(cand);
      continue;
    }
    const prefer =
      (cand.silenceMs ?? 0) > (last.silenceMs ?? 0) ||
      (endsWithSentenceBoundary(cand.snippet) &&
        !endsWithSentenceBoundary(last.snippet));
    if (prefer) {
      merged[merged.length - 1] = cand;
    }
  }
  return merged;
};

const scoreCandidate = (candidate, durationSeconds, mode) => {
  const timeSeconds = candidate.ms / 1000;
  let score = 0.4;
  if (candidate.silenceMs) {
    score += Math.min(0.4, (candidate.silenceMs / 2000) * 0.4);
  }
  if (mode === "song") {
    score += 0.1;
  }
  if (candidate.snippet && candidate.snippet !== "TRANSCRIPT_UNAVAILABLE") {
    if (endsWithSentenceBoundary(candidate.snippet)) {
      score += 0.3;
    } else {
      score -= 0.2;
    }
  }
  if (durationSeconds) {
    const ratio = timeSeconds / durationSeconds;
    if (ratio >= 0.2 && ratio <= 0.8) {
      score += 0.1;
    }
    if (timeSeconds < 5 || timeSeconds > durationSeconds - 5) {
      score -= 0.3;
    }
  }
  return clamp(score, 0, 1);
};

const buildFallbackProsCons = ({ mode, silenceMs, timeSeconds, durationSeconds }) => {
  const pros = [];
  if (mode === "song") {
    pros.push("Beat-aligned low-energy valley");
  } else if (silenceMs >= 800) {
    pros.push(`Natural pause detected (~${Math.round(silenceMs)}ms)`);
  } else if (silenceMs >= 500) {
    pros.push("Clear pause boundary detected");
  }
  pros.push("Low background energy at cut");
  pros.push("Clean sentence boundary / transition");

  const cons = [];
  if (silenceMs > 0 && silenceMs < 600) {
    cons.push("Short pause may feel abrupt");
  }
  if (durationSeconds) {
    if (timeSeconds < 10) {
      cons.push("Early placement may feel disruptive");
    } else if (timeSeconds > durationSeconds - 10) {
      cons.push("Late placement may feel rushed");
    }
  }
  cons.push("Slight background noise present");

  const pickedPros = pros.slice(0, 3);
  while (pickedPros.length < 3) {
    pickedPros.push("Natural pacing supports insertion");
  }
  const pickedCons = cons.slice(0, 2);
  while (pickedCons.length < 2) {
    pickedCons.push("Minor tonal shift possible");
  }

  return {
    pros: pickedPros,
    cons: pickedCons,
    rationale: `Chosen for a clear pause near ${timeSeconds.toFixed(1)}s that minimizes disruption.`,
  };
};

const selectTopSlots = (candidates, durationSeconds, minSeparationSeconds, count) => {
  const minSeparationMs = minSeparationSeconds * 1000;
  const sorted = [...candidates].sort(
    (a, b) => b.score - a.score || a.ms - b.ms,
  );
  const selected = [];
  for (const candidate of sorted) {
    const tooClose = selected.some(
      (entry) => Math.abs(entry.ms - candidate.ms) < minSeparationMs,
    );
    if (!tooClose) {
      selected.push(candidate);
    }
    if (selected.length >= count) break;
  }

  if (durationSeconds) {
    const fallbackTimes = [0.22, 0.5, 0.78].map(
      (ratio) => ratio * durationSeconds * 1000,
    );
    for (const fallback of fallbackTimes) {
      if (selected.length >= count) break;
      const tooClose = selected.some(
        (entry) => Math.abs(entry.ms - fallback) < minSeparationMs,
      );
      if (!tooClose && fallback >= 0 && fallback <= durationSeconds * 1000) {
        selected.push({
          ms: Math.round(fallback),
          silenceMs: 0,
          snippet: "",
          score: 0.5,
        });
      }
    }
  }

  while (selected.length < count) {
    let base = minSeparationMs;
    if (selected.length) {
      const latest = [...selected].sort((a, b) => a.ms - b.ms).slice(-1)[0];
      base = latest.ms + minSeparationMs;
    }
    const tooClose = selected.some(
      (entry) => Math.abs(entry.ms - base) < minSeparationMs,
    );
    const candidateMs = tooClose ? base + minSeparationMs : base;
    selected.push({
      ms: Math.round(candidateMs),
      silenceMs: 0,
      snippet: "",
      score: 0.4,
    });
  }

  return selected.slice(0, count);
};

const runPythonAnalyze = async (audioPath, mode) =>
  new Promise((resolve, reject) => {
    const pythonBin = process.env.PYTHON_BIN ?? "python";
    const args = [
      "-m",
      "ad_inserter.analyze_cli",
      "--audio",
      audioPath,
      "--mode",
      mode,
      "--snippet-count",
      "12",
    ];
    const child = spawn(pythonBin, args, {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout.trim() || "{}"));
        } catch (parseError) {
          reject(parseError);
        }
      } else {
        reject(new Error(stderr || `analyze_cli exited with code ${code}`));
      }
    });
  });

const generateStatementFallback = (name, productDesc) => {
  const brand = name || "Our sponsor";
  const desc = productDesc || "a thoughtful companion for your day";
  return `${brand} supports this episode with ${desc}, offering a simple way to stay focused and refreshed.`;
};

const generateBrandStatement = async ({ name, productDesc }) => {
  if (!process.env.OPENAI_API_KEY) {
    return generateStatementFallback(name, productDesc);
  }

  const statementCacheKey = cacheKey("statement", { name, productDesc });
  const cachedStatement = await cacheGetText(statementCacheKey);
  if (cachedStatement) return cachedStatement;

  const prompt = [
    "Write one sponsor read sentence (8-12 seconds when spoken).",
    "Sound native to the episode, calm and conversational.",
    "Avoid hypey marketing language and emojis.",
    `Brand name: ${name || "Sponsor"}.`,
    productDesc ? `Product description: ${productDesc}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: "You write concise sponsor reads." },
            { role: "user", content: prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "sponsor_statement",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  statement: { type: "string" },
                },
                required: ["statement"],
                additionalProperties: false,
              },
            },
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`OpenAI statement failed: ${response.status}`);
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    const statement = String(parsed.statement || "").trim();
    if (!statement) return generateStatementFallback(name, productDesc);
    await cacheSetText(statementCacheKey, statement, STATEMENT_CACHE_TTL_SECONDS);
    return statement;
  } catch (error) {
    console.warn("Statement generation failed, using fallback.", error);
    return generateStatementFallback(name, productDesc);
  }
};

const buildSponsorBlock = async ({
  voiceId,
  statements,
  modelId,
  outputFormat,
  pauseMs,
}) => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "sponsor-block-"),
  );
  const cleanup = async (paths) => {
    await Promise.all(
      paths.map((filePath) =>
        fs.promises.unlink(filePath).catch(() => undefined),
      ),
    );
    await fs.promises.rmdir(tempDir).catch(() => undefined);
  };

  const statementPaths = [];
  const allPaths = [];
  try {
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      const buffer = await synthesizeSpeech({
        voiceId,
        text: statement,
        modelId,
        outputFormat,
      });
      const statementPath = path.join(tempDir, `statement-${index}.mp3`);
      await fs.promises.writeFile(statementPath, buffer);
      statementPaths.push(statementPath);
      allPaths.push(statementPath);
    }

    const pauseSeconds = Math.max(0, (pauseMs ?? 150) / 1000);
    const pausePath = path.join(tempDir, "pause.mp3");
    if (statements.length > 1 && pauseSeconds > 0) {
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=channel_layout=stereo:sample_rate=44100`,
        "-t",
        pauseSeconds.toString(),
        pausePath,
      ]);
      allPaths.push(pausePath);
    }

    const concatInputs = [];
    const inputPaths = [];
    statementPaths.forEach((statementPath, index) => {
      inputPaths.push(statementPath);
      concatInputs.push(statementPath);
      if (index < statementPaths.length - 1 && pauseSeconds > 0) {
        inputPaths.push(pausePath);
        concatInputs.push(pausePath);
      }
    });

    const outputPath = path.join(tempDir, "sponsor_block.mp3");
    if (concatInputs.length === 1) {
      await fs.promises.copyFile(concatInputs[0], outputPath);
    } else {
      const filterParts = inputPaths.map(
        (_, idx) =>
          `[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
          `asetpts=PTS-STARTPTS[a${idx}]`,
      );
      const concatLabels = inputPaths.map((_, idx) => `[a${idx}]`).join("");
      const filter = [
        ...filterParts,
        `${concatLabels}concat=n=${inputPaths.length}:v=0:a=1[concat]`,
        `[concat]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
      ].join(";");
      const args = [
        "-y",
        ...inputPaths.flatMap((inputPath) => ["-i", inputPath]),
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        outputPath,
      ];
      await runFfmpeg(args);
    }

    const duration = await getAudioDuration(outputPath);
    if (duration !== null && duration > 20) {
      throw new Error("Sponsor block exceeds 20s limit.");
    }

    return {
      tempDir,
      outputPath,
      duration,
      cleanup: () => cleanup([...allPaths, outputPath]),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
};

const buildMergeFilter = ({ insertAt, previewSeconds, mainDuration }) => {
  const normalizedInsertAt = Math.max(0, insertAt);
  if (previewSeconds && previewSeconds > 0) {
    const previewStart = Math.max(0, normalizedInsertAt - previewSeconds);
    const previewEnd = mainDuration
      ? Math.min(mainDuration, normalizedInsertAt + previewSeconds)
      : normalizedInsertAt + previewSeconds;
    return {
      filter: [
        `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
          `atrim=${previewStart}:${normalizedInsertAt},asetpts=PTS-STARTPTS[a0]`,
        `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
          `atrim=${normalizedInsertAt}:${previewEnd},asetpts=PTS-STARTPTS[a1]`,
        `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
          `asetpts=PTS-STARTPTS[ad]`,
        `[a0][ad][a1]concat=n=3:v=0:a=1[out]`,
      ].join(";"),
      previewStart,
      previewEnd,
    };
  }
  return {
    filter: [
      `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
        `atrim=0:${normalizedInsertAt},asetpts=PTS-STARTPTS[a0]`,
      `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
        `atrim=${normalizedInsertAt},asetpts=PTS-STARTPTS[a1]`,
      `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
        `asetpts=PTS-STARTPTS[ad]`,
      `[a0][ad][a1]concat=n=3:v=0:a=1[out]`,
    ].join(";"),
    previewStart: null,
    previewEnd: null,
  };
};

const enhanceSlotsWithOpenAI = async ({ slots, candidates, mode, durationSeconds }) => {
  if (!process.env.OPENAI_API_KEY) return null;
  const payload = {
    mode,
    duration_seconds: durationSeconds,
    slots: slots.map((slot) => ({
      insertion_ms: slot.insertion_ms,
      insertion_time_seconds: slot.insertion_time_seconds,
      silence_ms: slot.silence_ms ?? 0,
      snippet: slot.snippet ?? "",
    })),
    candidates: candidates.map((cand) => ({
      insertion_ms: cand.ms,
      silence_ms: cand.silenceMs ?? 0,
      snippet: cand.snippet ?? "",
    })),
    rules: {
      pros_count: 3,
      cons_count: 2,
      max_words_per_bullet: 7,
    },
  };

  const prompt = [
    "Generate pros/cons and rationale for each slot.",
    "Use the provided slots; do not invent new times.",
    "Pros: exactly 3 bullets, short and specific.",
    "Cons: exactly 2 bullets, short and specific.",
    "Rationale: one sentence.",
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: "You are a precise audio editor." },
        { role: "user", content: `${prompt}\n\n${JSON.stringify(payload)}` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "slot_details",
          strict: true,
          schema: {
            type: "object",
            properties: {
              slots: {
                type: "array",
                minItems: slots.length,
                maxItems: slots.length,
                items: {
                  type: "object",
                  properties: {
                    insertion_ms: { type: "integer" },
                    pros: {
                      type: "array",
                      minItems: 3,
                      maxItems: 3,
                      items: { type: "string" },
                    },
                    cons: {
                      type: "array",
                      minItems: 2,
                      maxItems: 2,
                      items: { type: "string" },
                    },
                    rationale: { type: "string" },
                  },
                  required: ["insertion_ms", "pros", "cons", "rationale"],
                  additionalProperties: false,
                },
              },
            },
            required: ["slots"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI slot details failed: ${response.status}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.slots)) return null;
  return parsed.slots;
};

app.post(
  "/api/merge",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "insert", maxCount: 1 },
  ]),
  async (req, res) => {
    const audioFile = req.files?.audio?.[0];
    const insertFile = req.files?.insert?.[0];
    const insertAt = Number.parseFloat(req.body?.insertAt ?? "");
    const crossfade = Number.parseFloat(req.body?.crossfade ?? "0.08");
    const pause = Number.parseFloat(req.body?.pause ?? "0.2");
    const previewFlag = req.body?.preview ?? req.body?.mode;
    const previewSecondsValue = Number.parseFloat(req.body?.previewSeconds ?? "3");
    const previewSeconds = Number.isFinite(previewSecondsValue)
      ? previewSecondsValue
      : 3;
    const isPreview =
      previewFlag === "1" || previewFlag === "true" || previewFlag === "preview";

    if (!audioFile || !insertFile) {
      res.status(400).json({ error: "audio and insert files are required." });
      return;
    }

    if (!Number.isFinite(insertAt) || insertAt < 0) {
      res.status(400).json({ error: "insertAt must be a positive number." });
      return;
    }

    if (!Number.isFinite(crossfade) || crossfade < 0) {
      res.status(400).json({ error: "crossfade must be a positive number." });
      return;
    }

    if (!Number.isFinite(pause) || pause < 0) {
      res.status(400).json({ error: "pause must be a positive number." });
      return;
    }

    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "voice-merge-"),
    );
    const basePath = path.join(tempDir, "base.mp3");
    const insertPath = path.join(tempDir, "insert.mp3");
    const outPath = path.join(tempDir, "merged.mp3");
    const cleanup = async () => {
      await Promise.all(
        [basePath, insertPath, outPath].map((filePath) =>
          fs.promises.unlink(filePath).catch(() => undefined),
        ),
      );
      await fs.promises.rmdir(tempDir).catch(() => undefined);
    };

    try {
      await fs.promises.writeFile(basePath, audioFile.buffer);
      await fs.promises.writeFile(insertPath, insertFile.buffer);

      // Get main audio duration to validate and clamp insertAt
      const mainDuration = await getAudioDuration(basePath);
      const adDuration = await getAudioDuration(insertPath);

      // Validate and clamp insertAt
      let clampedInsertAt = insertAt;
      if (mainDuration !== null) {
        if (clampedInsertAt < 0) {
          clampedInsertAt = 0;
        } else if (clampedInsertAt > mainDuration) {
          clampedInsertAt = mainDuration;
        }
      }

      // Debug logging
      let expectedDuration = null;
      if (adDuration !== null) {
        if (isPreview) {
          const start = Math.max(0, clampedInsertAt - previewSeconds);
          const end =
            mainDuration !== null
              ? Math.min(mainDuration, clampedInsertAt + previewSeconds)
              : clampedInsertAt + previewSeconds;
          expectedDuration = Math.max(0, end - start) + adDuration;
        } else if (mainDuration !== null) {
          expectedDuration = mainDuration + adDuration;
        }
      }
      console.log("Merge debug:", {
        mainDuration: mainDuration?.toFixed(3),
        insertDuration: adDuration?.toFixed(3),
        insertAt: insertAt.toFixed(3),
        expectedDuration: expectedDuration?.toFixed(3),
      });

      const { filter, previewStart, previewEnd } = buildMergeFilter({
        insertAt: clampedInsertAt,
        previewSeconds: isPreview ? previewSeconds : 0,
        mainDuration,
      });

      if (isPreview) {
        console.log("Preview window:", {
          start: previewStart?.toFixed(3),
          end: previewEnd?.toFixed(3),
        });
      }

      // Input 0: main audio
      // Input 1: insert audio
      const args = [
        "-y",
        "-i", basePath,
        "-i", insertPath,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        outPath,
      ];

      await runFfmpeg(args);
      await fs.promises.access(outPath);
      
      // Log final duration for verification
      const finalDuration = await getAudioDuration(outPath).catch(() => null);
      if (finalDuration !== null) {
        console.log("Merge result:", {
          finalDuration: finalDuration.toFixed(3),
          expectedDuration: expectedDuration?.toFixed(3),
          match:
            expectedDuration !== null
              ? Math.abs(finalDuration - expectedDuration) < 0.1
              : "unknown",
        });
      }
      
      res.setHeader("Content-Type", "audio/mpeg");

      const stream = fs.createReadStream(outPath);
      stream.on("error", (streamError) => {
        if (!res.headersSent) {
          res.status(500).json({
            error:
              streamError instanceof Error
                ? streamError.message
                : "Failed to stream merged audio.",
          });
        }
      });
      res.on("close", cleanup);
      res.on("finish", cleanup);
      stream.pipe(res);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Merge failed.",
      });
      await cleanup();
    }
  },
);

app.post("/api/insert-sections", upload.single("audio"), async (req, res) => {
  const audioFile = req.file;
  const count = Number.parseInt(req.body?.count ?? "5", 10);

  if (!audioFile) {
    res.status(400).json({ error: "audio file is required." });
    return;
  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "insert-sections-"),
  );
  const audioPath = path.join(
    tempDir,
    `${Date.now()}-${audioFile.originalname || "audio.mp3"}`,
  );
  const cleanup = async () => {
    await fs.promises.unlink(audioPath).catch(() => undefined);
    await fs.promises.rmdir(tempDir).catch(() => undefined);
  };

  try {
    await fs.promises.writeFile(audioPath, audioFile.buffer);
    const duration = await getAudioDuration(audioPath).catch(() => null);
    const mode =
      String(req.body?.mode ?? "podcast").trim().toLowerCase() === "song"
        ? "song"
        : "podcast";
    let analysisResult = null;
    try {
      analysisResult = await runPythonAnalyze(audioPath, mode);
    } catch (error) {
      console.warn("Analyze CLI failed, using fallback.", error);
    }

    const durationMs = Number(analysisResult?.duration_ms ?? 0) || null;
    const durationSeconds =
      duration ?? (durationMs ? durationMs / 1000 : null);

    let transcriptCandidates = [];
    if (process.env.OPENAI_API_KEY) {
      try {
        const transcriptForm = new FormData();
        transcriptForm.append("model", "whisper-1");
        transcriptForm.append("response_format", "verbose_json");
        transcriptForm.append(
          "file",
          new Blob([audioFile.buffer]),
          audioFile.originalname || "audio.mp3",
        );

        const transcriptResponse = await fetch(
          "https://api.openai.com/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: transcriptForm,
          },
        );

        if (transcriptResponse.ok) {
          const transcript = await transcriptResponse.json();
          const segments = Array.isArray(transcript?.segments)
            ? transcript.segments
            : [];
          transcriptCandidates = segments
            .map((segment, index) => {
              const text = String(segment.text ?? "").trim();
              if (!endsWithSentenceBoundary(text)) return null;
              const end = Number(segment.end ?? 0);
              if (!Number.isFinite(end)) return null;
              if (durationSeconds && end > durationSeconds) return null;
              const nextStart = Number(segments[index + 1]?.start ?? end);
              const gapMs = Math.max(0, (nextStart - end) * 1000);
              return {
                ms: Math.round(end * 1000),
                silenceMs: Math.round(gapMs),
                snippet: text,
              };
            })
            .filter(Boolean);
        }
      } catch (error) {
        console.warn("OpenAI transcript candidates failed.", error);
      }
    }

    const snippetsRaw = analysisResult?.snippets ?? {};
    const snippets = Object.fromEntries(
      Object.entries(snippetsRaw).map(([key, value]) => [
        Number.parseInt(key, 10),
        String(value ?? "").trim(),
      ]),
    );

    const candidates = Array.isArray(analysisResult?.candidates)
      ? analysisResult.candidates
          .map((entry) => {
            const ms = Number(entry.mid_ms ?? entry.ms ?? entry.time_ms ?? 0);
            if (!Number.isFinite(ms) || ms < 0) return null;
            const silenceMs = Number(entry.silence_ms ?? 0);
            return {
              ms: Math.round(ms),
              silenceMs: Number.isFinite(silenceMs) ? silenceMs : 0,
              snippet: snippets[Math.round(ms)] ?? "",
            };
          })
          .filter(Boolean)
      : [];
    const maxMs = durationSeconds ? durationSeconds * 1000 : null;
    const boundedCandidates =
      maxMs !== null
        ? candidates.filter((entry) => entry.ms <= maxMs)
        : candidates;
    const combinedCandidates = mergeCandidates(
      boundedCandidates,
      transcriptCandidates,
    );

    const fallbackCandidates =
      durationSeconds && durationSeconds > 0
        ? [0.25, 0.5, 0.75].map((ratio) => ({
            ms: Math.round(durationSeconds * ratio * 1000),
            silenceMs: 0,
            snippet: "",
          }))
        : [
            { ms: 12000, silenceMs: 0, snippet: "" },
            { ms: 24000, silenceMs: 0, snippet: "" },
            { ms: 36000, silenceMs: 0, snippet: "" },
          ];

    const usableCandidates = combinedCandidates.length
      ? combinedCandidates
      : fallbackCandidates;
    const scoredCandidates = usableCandidates.map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, durationSeconds, mode),
    }));

    console.log("Analyze candidates:", {
      count: scoredCandidates.length,
      mode,
    });

    const selected = selectTopSlots(
      scoredCandidates,
      durationSeconds,
      6,
      Number.isFinite(count) ? Math.max(3, count) : 3,
    ).slice(0, 3);

    const maxSlotMs =
      durationSeconds !== null && durationSeconds !== undefined
        ? Math.max(0, Math.round(durationSeconds * 1000) - 200)
        : null;
    const normalizedSelected = selected.map((candidate) => {
      if (maxSlotMs === null) return candidate;
      return {
        ...candidate,
        ms: Math.min(candidate.ms, maxSlotMs),
      };
    });
    const dedupedSelected = [];
    const seenMs = new Set();
    for (const candidate of normalizedSelected) {
      if (seenMs.has(candidate.ms)) continue;
      seenMs.add(candidate.ms);
      dedupedSelected.push(candidate);
    }

    let slots = dedupedSelected.map((candidate) => {
      const timeSeconds = candidate.ms / 1000;
      const clampedTimeSeconds =
        durationSeconds !== null && durationSeconds !== undefined
          ? Math.min(Math.max(0, timeSeconds), durationSeconds)
          : Math.max(0, timeSeconds);
      const clampedMs = Math.round(clampedTimeSeconds * 1000);
      const confidence = Math.round(clamp(70 + candidate.score * 25, 70, 95));
      const fallbackText = buildFallbackProsCons({
        mode,
        silenceMs: candidate.silenceMs,
        timeSeconds: clampedTimeSeconds,
        durationSeconds,
      });
      return {
        insertion_ms: clampedMs,
        insertion_time_seconds: Number(clampedTimeSeconds.toFixed(3)),
        confidence_percent: confidence,
        pros: fallbackText.pros,
        cons: fallbackText.cons,
        rationale: fallbackText.rationale,
        silence_ms: candidate.silenceMs,
        snippet: candidate.snippet ?? "",
      };
    });

    try {
      const openAiDetails = await enhanceSlotsWithOpenAI({
        slots,
        candidates: scoredCandidates,
        mode,
        durationSeconds,
      });
      if (openAiDetails) {
        slots = slots.map((slot) => {
          const match = openAiDetails.find(
            (entry) => Number(entry.insertion_ms) === slot.insertion_ms,
          );
          if (!match) return slot;
          return {
            ...slot,
            pros:
              Array.isArray(match.pros) && match.pros.length === 3
                ? match.pros
                : slot.pros,
            cons:
              Array.isArray(match.cons) && match.cons.length === 2
                ? match.cons
                : slot.cons,
            rationale:
              typeof match.rationale === "string" && match.rationale.trim()
                ? match.rationale.trim()
                : slot.rationale,
          };
        });
      }
    } catch (error) {
      console.warn("OpenAI slot details failed, using fallback.", error);
    }

    slots.sort((a, b) => b.confidence_percent - a.confidence_percent);

    console.log("Analyze top slots:", slots.map((slot) => ({
      insertion_ms: slot.insertion_ms,
      confidence_percent: slot.confidence_percent,
    })));

    const sponsorsField = parseJsonField(req.body?.sponsors);
    const statementsField = req.body?.statements ?? req.body?.statement;
    let sponsorStatements = [];
    if (Array.isArray(sponsorsField)) {
      sponsorStatements = await Promise.all(
        sponsorsField.map(async (entry, index) => {
          const name = String(entry?.name ?? entry?.brand ?? "").trim();
          const productDesc = String(entry?.productDesc ?? "").trim();
          const rawStatement = String(entry?.statement ?? "").trim();
          const statement =
            rawStatement ||
            (await generateBrandStatement({ name, productDesc }));
          return {
            id: entry?.id ?? `sponsor-${index + 1}`,
            name,
            statement,
            generated: !rawStatement,
          };
        }),
      );
    } else {
      const statements = normalizeStatements(statementsField);
      sponsorStatements = statements.map((statement, index) => ({
        id: `sponsor-${index + 1}`,
        name: "",
        statement,
        generated: false,
      }));
    }

    const points = slots.map((slot) => slot.insertion_time_seconds);
    const confidences = slots.map((slot) => slot.confidence_percent);

    res.json({
      points,
      confidences,
      duration: durationSeconds,
      source: analysisResult ? "heuristic" : "fallback",
      slots,
      sponsorStatements,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Insert analysis failed.",
    });
  } finally {
    await cleanup();
  }
});

app.post("/api/related-products", upload.single("audio"), async (req, res) => {
  const audioFile = req.file;
  if (!audioFile) {
    res.status(400).json({ error: "audio file is required." });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({
      error: "OPENAI_API_KEY not configured. Please set it in your environment.",
    });
    return;
  }

  if (!process.env.SERPAPI_KEY) {
    res.status(500).json({
      error: "SERPAPI_KEY not configured. Please set it in your environment.",
    });
    return;
  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "related-products-"),
  );
  const audioPath = path.join(
    tempDir,
    `${Date.now()}-${audioFile.originalname || "audio.mp3"}`,
  );
  const cleanup = async () => {
    await fs.promises.unlink(audioPath).catch(() => undefined);
    await fs.promises.rmdir(tempDir).catch(() => undefined);
  };

  try {
    await fs.promises.writeFile(audioPath, audioFile.buffer);

    const transcriptForm = new FormData();
    transcriptForm.append("model", "whisper-1");
    transcriptForm.append("response_format", "verbose_json");
    transcriptForm.append(
      "file",
      new Blob([audioFile.buffer]),
      audioFile.originalname || "audio.mp3",
    );

    const transcriptResponse = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: transcriptForm,
      },
    );

    if (!transcriptResponse.ok) {
      const detail = await transcriptResponse.text();
      throw new Error(
        `Transcription failed: ${transcriptResponse.status} ${detail}`,
      );
    }

    const transcript = await transcriptResponse.json();
    const segments = Array.isArray(transcript?.segments)
      ? transcript.segments
      : [];
    const transcriptText = segments
      .map((segment) => String(segment.text ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 3000);

    const completionResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "Extract up to 3 product search terms from the transcript. " +
                "Focus on concrete product mentions or categories suitable for shopping searches. " +
                "Return JSON only.",
            },
            {
              role: "user",
              content: `Transcript: ${transcriptText}`,
            },
          ],
          response_format: { type: "json_object" },
        }),
      },
    );

    if (!completionResponse.ok) {
      const detail = await completionResponse.text();
      throw new Error(
        `OpenAI selection failed: ${completionResponse.status} ${detail}`,
      );
    }

    const completion = await completionResponse.json();
    const rawContent =
      completion?.choices?.[0]?.message?.content?.trim() ?? "{}";
    let terms = [];
    try {
      const parsed = JSON.parse(rawContent);
      if (Array.isArray(parsed.products)) {
        terms = parsed.products
          .map((item) => (item?.term ? String(item.term) : ""))
          .filter(Boolean);
      } else if (Array.isArray(parsed.terms)) {
        terms = parsed.terms.map((item) => String(item)).filter(Boolean);
      }
    } catch (parseError) {
      terms = [];
    }

    const uniqueTerms = [...new Set(terms)].slice(0, 3);
    const results = [];

    for (const term of uniqueTerms) {
      const params = new URLSearchParams({
        engine: "google_shopping",
        q: term,
        api_key: process.env.SERPAPI_KEY,
        num: "3",
      });
      const serpResponse = await fetch(
        `https://serpapi.com/search.json?${params.toString()}`,
      );
      if (!serpResponse.ok) {
        const detail = await serpResponse.text();
        throw new Error(
          `SerpAPI search failed: ${serpResponse.status} ${detail}`,
        );
      }
      const serpJson = await serpResponse.json();
      const items = Array.isArray(serpJson.shopping_results)
        ? serpJson.shopping_results.slice(0, 3).map((item) => ({
            title: item.title ?? "",
            link: item.link ?? "",
            price: item.price ?? "",
            source: item.source ?? "",
            thumbnail: item.thumbnail ?? "",
          }))
        : [];
      results.push({ term, items });
    }

    res.json({
      terms: uniqueTerms,
      results,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Related products failed.",
    });
  } finally {
    await cleanup();
  }
});

app.post("/api/tts", async (req, res) => {
  const { voiceId, modelId, outputFormat, pauseMs } = req.body ?? {};
  let statements = normalizeStatements(
    req.body?.statements ?? req.body?.texts ?? req.body?.text,
  );
  if (!voiceId) {
    res.status(400).json({ error: "voiceId is required." });
    return;
  }

  if (statements.length === 0) {
    const sponsor = req.body?.sponsor ?? {};
    const name = String(
      sponsor?.name ?? req.body?.name ?? req.body?.brand ?? "",
    ).trim();
    const productDesc = String(
      sponsor?.productDesc ?? req.body?.productDesc ?? "",
    ).trim();
    const generated = await generateBrandStatement({ name, productDesc });
    if (generated) {
      statements = [generated];
    }
  }

  if (statements.length === 0) {
    res.status(400).json({ error: "text is required." });
    return;
  }

  try {
    console.log("TTS statements:", { count: statements.length, statements });
    if (statements.length === 1) {
      const buffer = await synthesizeSpeech({
        voiceId,
        text: statements[0],
        modelId,
        outputFormat,
      });
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(buffer);
      return;
    }

    const pauseMsValue = Number.parseFloat(pauseMs ?? "150");
    const normalizedPauseMs = Number.isFinite(pauseMsValue)
      ? pauseMsValue
      : 150;

    const sponsorBlock = await buildSponsorBlock({
      voiceId,
      statements,
      modelId,
      outputFormat,
      pauseMs: normalizedPauseMs,
    });

    res.setHeader("Content-Type", "audio/mpeg");
    const stream = fs.createReadStream(sponsorBlock.outputPath);
    stream.on("error", (streamError) => {
      if (!res.headersSent) {
        res.status(500).json({
          error:
            streamError instanceof Error
              ? streamError.message
              : "Failed to stream TTS audio.",
        });
      }
    });
    res.on("close", sponsorBlock.cleanup);
    res.on("finish", sponsorBlock.cleanup);
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "TTS failed.",
    });
  }
});

app.post("/api/speech", async (req, res) => {
  res.redirect(307, "/api/tts");
});

app.post("/api/generate", upload.single("audio"), async (req, res) => {
  const audioFile = req.file;
  const voiceId = req.body?.voiceId?.toString()?.trim();
  const voiceIds = req.body?.voiceIds?.toString()?.trim();
  const brand = req.body?.brand?.toString()?.trim();
  const productDesc = req.body?.productDesc?.toString()?.trim();

  if (!audioFile) {
    res.status(400).json({ error: "audio file is required." });
    return;
  }

  if (!voiceId && !voiceIds) {
    res.status(400).json({ error: "voiceId or voiceIds is required." });
    return;
  }

  if (!brand) {
    res.status(400).json({ error: "brand is required." });
    return;
  }

  const resolvedDesc =
    productDesc || `A short audio ad spot for ${brand}.`;

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "ad-generate-"),
  );
  const basePath = path.join(tempDir, "base.mp3");
  const outPath = path.join(tempDir, "out.mp3");
  const cleanup = async () => {
    await Promise.all(
      [basePath, outPath].map((filePath) =>
        fs.promises.unlink(filePath).catch(() => undefined),
      ),
    );
    await fs.promises.rmdir(tempDir).catch(() => undefined);
  };

  try {
    await fs.promises.writeFile(basePath, audioFile.buffer);

    const pythonBin = process.env.PYTHON_BIN ?? "python";
    const baseUrl =
      process.env.API_BASE_URL ?? `http://localhost:${port}`;

    const args = [
      "-m",
      "ad_inserter.cli",
      "--main",
      basePath,
      ...(voiceIds ? ["--voice-ids", voiceIds] : ["--voice-id", voiceId]),
      "--product-name",
      brand,
      "--product-desc",
      resolvedDesc,
      "--out",
      outPath,
      "--tts-url",
      `${baseUrl}/api/tts`,
      "--merge-url",
      `${baseUrl}/api/merge`,
    ];

    await new Promise((resolve, reject) => {
      const child = spawn(pythonBin, args, {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: process.env,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(null);
        } else {
          reject(
            new Error(
              stderr || `ad_inserter exited with code ${code}`,
            ),
          );
        }
      });
    });
    await fs.promises.access(outPath);
    res.setHeader("Content-Type", "audio/mpeg");
    const stream = fs.createReadStream(outPath);
    stream.on("error", (streamError) => {
      if (!res.headersSent) {
        res.status(500).json({
          error:
            streamError instanceof Error
              ? streamError.message
              : "Failed to stream output.",
        });
      }
    });
    res.on("close", cleanup);
    res.on("finish", cleanup);
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Generation failed.",
    });
    await cleanup();
  }
});

app.post("/ad/insert", upload.single("audio"), async (req, res) => {
  const audioFile = req.file;
  const productName = req.body?.productName?.toString()?.trim();
  const productBlurb = req.body?.productBlurb?.toString()?.trim();
  const adStyle = req.body?.adStyle?.toString()?.trim();
  const adMode = req.body?.adMode?.toString()?.trim();
  const voiceIdA = req.body?.voiceIdA?.toString()?.trim();
  const voiceIdB = req.body?.voiceIdB?.toString()?.trim();
  const llmProvider = req.body?.llmProvider?.toString()?.trim();
  const llmModel = req.body?.llmModel?.toString()?.trim();
  const cloneVoices =
    req.body?.cloneVoices?.toString()?.trim().toLowerCase() === "true";

  if (!audioFile) {
    res.status(400).json({ error: "audio file is required." });
    return;
  }

  if (!productName) {
    res.status(400).json({ error: "productName is required." });
    return;
  }

  if (!productBlurb) {
    res.status(400).json({ error: "productBlurb is required." });
    return;
  }

  if (!adStyle || !["casual", "serious", "funny"].includes(adStyle)) {
    res.status(400).json({ error: "adStyle must be casual, serious, or funny." });
    return;
  }

  if (!adMode || !["A_ONLY", "B_ONLY", "DUO"].includes(adMode)) {
    res.status(400).json({ error: "adMode must be A_ONLY, B_ONLY, or DUO." });
    return;
  }

  // This pipeline (diarization + LLM copywriting + ElevenLabs TTS + ffmpeg
  // mix) can run well past typical HTTP timeouts, so it's handed off to a
  // Redis-backed queue (BullMQ) instead of running inline. The uploaded file
  // is written to a directory shared with the worker (JOB_STORAGE_DIR, a
  // Docker volume in docker-compose), the job is enqueued, and this handler
  // returns immediately with a jobId the client polls via GET /api/jobs/:id.
  const jobId = randomUUID();
  try {
    const dir = await createJobDir(jobId);
    const inputPath = path.join(dir, "input.mp3");
    const outputPath = path.join(dir, "output.mp3");
    await fs.promises.writeFile(inputPath, audioFile.buffer);

    const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${port}`;

    await adInsertQueue.add(
      "ad-insert",
      {
        inputPath,
        outputPath,
        productName,
        productBlurb,
        adStyle,
        adMode,
        voiceIdA,
        voiceIdB,
        llmProvider,
        llmModel,
        cloneVoices,
        apiBaseUrl,
      },
      { jobId },
    );

    res.status(202).json({
      jobId,
      statusUrl: `/api/jobs/${jobId}`,
      resultUrl: `/api/jobs/${jobId}/result`,
    });
  } catch (error) {
    await fs.promises.rm(jobDir(jobId), { recursive: true, force: true }).catch(
      () => undefined,
    );
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to queue job.",
    });
  }
});

// Poll job status: queued -> active -> completed | failed.
app.get("/api/jobs/:id", async (req, res) => {
  const job = await adInsertQueue.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  const state = await job.getState();
  res.json({
    id: job.id,
    state,
    progress: job.progress ?? 0,
    failedReason: state === "failed" ? job.failedReason ?? null : null,
    resultUrl: state === "completed" ? `/api/jobs/${job.id}/result` : null,
  });
});

// Download the finished audio once GET /api/jobs/:id reports "completed".
app.get("/api/jobs/:id/result", async (req, res) => {
  const job = await adInsertQueue.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  const state = await job.getState();
  if (state !== "completed") {
    res.status(409).json({ error: `Job is not completed yet (state: ${state}).` });
    return;
  }

  const outputPath = job.returnvalue?.outputPath;
  if (!outputPath || !fs.existsSync(outputPath)) {
    res.status(410).json({ error: "Result is no longer available." });
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  const stream = fs.createReadStream(outputPath);
  stream.on("error", (streamError) => {
    if (!res.headersSent) {
      res.status(500).json({
        error:
          streamError instanceof Error
            ? streamError.message
            : "Failed to stream result.",
      });
    }
  });
  stream.pipe(res);
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(", ")}`);
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn(
      "⚠️  ELEVENLABS_API_KEY not set. Voice cloning and TTS endpoints will fail.",
    );
  } else {
    console.log("✓ ElevenLabs API key configured");
  }
});
