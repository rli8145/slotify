import "dotenv/config";
import fs from "node:fs";
import { Worker } from "bullmq";
import { redisConnection } from "./lib/redis.mjs";
import { AD_INSERT_QUEUE_NAME } from "./lib/queue.mjs";
import { removeJobDir } from "./lib/jobStorage.mjs";
import { runAdInsertPipeline } from "./jobs/adInsertJob.mjs";

const concurrency = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);

const worker = new Worker(
  AD_INSERT_QUEUE_NAME,
  async (job) => {
    const { inputPath, outputPath, ...params } = job.data;

    await job.updateProgress(5);
    await runAdInsertPipeline({
      inputPath,
      outputPath,
      ...params,
      onLog: () => {
        // Nudge progress while ffmpeg/python are running so polling clients
        // see movement even though the pipeline doesn't report fine-grained %.
        job.updateProgress(50).catch(() => undefined);
      },
    });
    await fs.promises.access(outputPath);
    await job.updateProgress(100);

    // Only the output is needed for the result download; drop the (often
    // large) input upload once processing is done.
    await fs.promises.unlink(inputPath).catch(() => undefined);

    return { outputPath };
  },
  { connection: redisConnection, concurrency },
);

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed -> ${job.returnvalue?.outputPath}`);
});

worker.on("failed", async (job, error) => {
  console.error(`[worker] job ${job?.id} failed:`, error?.message);
  if (job) {
    // Nothing usable will ever be downloaded for a failed job; free the disk.
    await removeJobDir(job.id).catch(() => undefined);
  }
});

console.log(
  `[worker] listening on queue "${AD_INSERT_QUEUE_NAME}" (concurrency=${concurrency})`,
);
