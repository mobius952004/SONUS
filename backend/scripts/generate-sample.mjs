import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const outputDir = path.resolve("samples");
await mkdir(outputDir, { recursive: true });
const outputFile = path.join(outputDir, "sample-voice.wav");

const proc = spawn(ffmpegPath, [
  "-y",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=8",
  "-ac",
  "1",
  "-ar",
  "16000",
  outputFile,
]);

proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
proc.on("close", (code) => {
  if (code === 0) {
    console.log(`Generated ${outputFile}`);
  } else {
    console.error("Failed to generate sample file.");
    process.exit(1);
  }
});
