import { Queue } from "bullmq";
import { redisConnection } from "./redis.mjs";

export const AD_INSERT_QUEUE_NAME = "ad-insert";

// The two-speaker ad insertion pipeline (Whisper/diarization + OpenAI +
// ElevenLabs TTS + ffmpeg mix) can take well over a minute. Queuing it means
// POST /ad/insert can respond immediately with a jobId instead of holding
// the HTTP connection open for the whole pipeline.
export const adInsertQueue = new Queue(AD_INSERT_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 60 * 60 }, // keep completed jobs 1h for polling
    removeOnFail: { age: 24 * 60 * 60 }, // keep failures around longer to debug
  },
});
