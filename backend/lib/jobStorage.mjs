import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// In docker-compose this points at a volume shared between the `backend`
// and `worker` containers (e.g. /data/jobs) so the worker can read the file
// the API process wrote, and the API process can later stream back the file
// the worker produced. Outside Docker it falls back to the OS tmpdir so
// `npm run dev` still works without Redis/Docker running.
const baseDir = process.env.JOB_STORAGE_DIR ?? os.tmpdir();

export const jobDir = (jobId) => path.join(baseDir, jobId);

export const createJobDir = async (jobId) => {
  const dir = jobDir(jobId);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
};

export const removeJobDir = async (jobId) => {
  await fs.promises.rm(jobDir(jobId), { recursive: true, force: true });
};
