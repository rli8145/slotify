import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// backend/jobs/adInsertJob.mjs -> backend/ is one directory up.
const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Runs the same `python -m ad_inserter.insert_ad` pipeline that used to run
// inline inside the POST /ad/insert route handler. Extracted so both the API
// process (for a quick synchronous check, if ever needed) and the queue
// worker (backend/worker.mjs) can call it.
export async function runAdInsertPipeline({
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
  onLog,
}) {
  const pythonBin = process.env.PYTHON_BIN ?? "python";

  const args = [
    "-m",
    "ad_inserter.insert_ad",
    "--input",
    inputPath,
    "--product-name",
    productName,
    "--product-blurb",
    productBlurb,
    "--ad-style",
    adStyle,
    "--ad-mode",
    adMode,
    "--out",
    outputPath,
    "--tts-url",
    `${apiBaseUrl}/api/tts`,
    "--clone-url",
    `${apiBaseUrl}/api/clone`,
  ];

  if (voiceIdA) args.push("--voice-id-a", voiceIdA);
  if (voiceIdB) args.push("--voice-id-b", voiceIdB);
  if (llmProvider) args.push("--llm-provider", llmProvider);
  if (llmModel) args.push("--llm-model", llmModel);
  if (cloneVoices) args.push("--clone-voices");

  await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, {
      cwd: backendRoot,
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onLog?.(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(null);
      } else {
        reject(
          new Error(stderr || `ad_inserter.insert_ad exited with code ${code}`),
        );
      }
    });
  });
}
