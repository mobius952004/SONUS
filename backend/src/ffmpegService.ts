import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";

export type FiltersPayload = {
  passType: "none" | "highpass" | "lowpass";
  passFrequency: number;
  echoEnabled: boolean;
  echoDelay: number;
  echoDecay: number;
  noiseEnabled: boolean;
  noiseFloor: number;
  trimSilenceEnabled: boolean;
  trimSilenceThreshold: number;
  trimSilenceMinDuration: number;
};

export type Region = {
  id: string;
  start: number;
  end: number;
};

const ffmpegBinary = ffmpegPath as string;
const ffprobeBinary = ffprobePath.path;

const ensureDir = async (dirPath: string) => fs.mkdir(dirPath, { recursive: true });

export const runFfmpeg = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBinary, ["-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || "FFmpeg failed"));
    });
  });

const runTool = (binary: string, args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const proc = spawn(binary, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });

export const convertToStandardWav = async (inputPath: string, outputPath: string) => {
  await ensureDir(path.dirname(outputPath));
  await runFfmpeg(["-i", inputPath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath]);
};

const buildFilterChain = (filters: FiltersPayload) => {
  const chain: string[] = [];
  if (filters.passType !== "none") {
    chain.push(`${filters.passType}=f=${Math.max(20, Math.min(20000, filters.passFrequency))}`);
  }
  if (filters.echoEnabled) {
    const delay = Math.max(1, filters.echoDelay);
    const decay = Math.max(0, Math.min(1, filters.echoDecay));
    chain.push(`aecho=0.8:0.9:${delay}:${decay}`);
  }
  if (filters.noiseEnabled) {
    chain.push(`afftdn=nf=${Math.max(-80, Math.min(-10, filters.noiseFloor))}`);
  }
  if (filters.trimSilenceEnabled) {
    const threshold = Math.max(-80, Math.min(-10, filters.trimSilenceThreshold));
    const minDuration = Math.max(0.05, Math.min(2, filters.trimSilenceMinDuration));
    chain.push(`silenceremove=start_periods=1:start_duration=${minDuration}:start_threshold=${threshold}dB`);
  }
  return chain.join(",");
};

export const applyFilters = async (inputPath: string, outputPath: string, filters: FiltersPayload) => {
  const filterChain = buildFilterChain(filters);
  await ensureDir(path.dirname(outputPath));
  if (!filterChain) {
    await fs.copyFile(inputPath, outputPath);
    return;
  }
  await runFfmpeg(["-i", inputPath, "-af", filterChain, outputPath]);
};

export const exportFullAudio = async (inputPath: string, outputPath: string) => {
  await ensureDir(path.dirname(outputPath));
  await runFfmpeg(["-i", inputPath, outputPath]);
};

export const exportSelectedRegions = async (inputPath: string, outputPath: string, regions: Region[]) => {
  await ensureDir(path.dirname(outputPath));
  const validRegions = regions.filter((r) => r.start >= 0 && r.end > r.start).sort((a, b) => a.start - b.start);
  if (!validRegions.length) throw new Error("No valid regions for selected export.");
  const filterParts = validRegions.map(
    (region, index) => `[0:a]atrim=start=${region.start}:end=${region.end},asetpts=PTS-STARTPTS[a${index}]`,
  );
  const concatInputs = validRegions.map((_, index) => `[a${index}]`).join("");
  const filterComplex = `${filterParts.join(";")};${concatInputs}concat=n=${validRegions.length}:v=0:a=1[out]`;
  await runFfmpeg(["-i", inputPath, "-filter_complex", filterComplex, "-map", "[out]", outputPath]);
};

const mergeIntervals = (intervals: { start: number; end: number }[]) => {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const iv of sorted) {
    if (!merged.length || iv.start > merged[merged.length - 1].end) {
      merged.push({ ...iv });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
    }
  }
  return merged;
};

/** Removes the given time ranges from the audio and concatenates the remainder (new file, shorter duration). */
export const removeTimeRangesFromAudio = async (inputPath: string, outputPath: string, removeRegions: Region[]) => {
  await ensureDir(path.dirname(outputPath));
  const probe = await runTool(ffprobeBinary, ["-v", "error", "-show_format", "-of", "json", inputPath]);
  if (probe.code !== 0) throw new Error("Failed to read audio duration for cut.");
  const probeJson = JSON.parse(probe.stdout) as { format?: { duration?: string } };
  const durationSec = Number(probeJson.format?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Invalid audio duration.");

  const clamped = removeRegions
    .filter((r) => r.end > r.start)
    .map((r) => ({
      start: Math.max(0, r.start),
      end: Math.min(durationSec, r.end),
    }))
    .filter((r) => r.end > r.start);

  const mergedRemove = mergeIntervals(clamped);
  if (!mergedRemove.length) throw new Error("No valid ranges to remove.");

  const keep: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const r of mergedRemove) {
    if (r.start > cursor) {
      keep.push({ start: cursor, end: r.start });
    }
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < durationSec) {
    keep.push({ start: cursor, end: durationSec });
  }
  const validKeep = keep.filter((k) => k.end > k.start);
  if (!validKeep.length) throw new Error("Removing these ranges would delete the entire file.");

  const filterParts = validKeep.map(
    (seg, index) => `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${index}]`,
  );
  const concatInputs = validKeep.map((_, index) => `[a${index}]`).join("");
  const filterComplex = `${filterParts.join(";")};${concatInputs}concat=n=${validKeep.length}:v=0:a=1[out]`;
  await runFfmpeg(["-i", inputPath, "-filter_complex", filterComplex, "-map", "[out]", outputPath]);
};

export const exportChunks = async (inputPath: string, outputDir: string, baseName: string, ext: "wav" | "mp3", regions: Region[]) => {
  await ensureDir(outputDir);
  const validRegions = regions.filter((r) => r.start >= 0 && r.end > r.start).sort((a, b) => a.start - b.start);
  if (!validRegions.length) throw new Error("No valid regions for chunk export.");
  const outputs: string[] = [];
  for (let i = 0; i < validRegions.length; i += 1) {
    const region = validRegions[i];
    const outputPath = path.join(outputDir, `${baseName}-chunk-${i + 1}.${ext}`);
    await runFfmpeg(["-i", inputPath, "-ss", `${region.start}`, "-to", `${region.end}`, outputPath]);
    outputs.push(outputPath);
  }
  return outputs;
};

export const exportChunksByDuration = async (
  inputPath: string,
  outputDir: string,
  baseName: string,
  ext: "wav" | "mp3",
  chunkDurationSec: number,
) => {
  await ensureDir(outputDir);
  const safeChunkDuration = Math.max(1, Math.min(3600, chunkDurationSec));
  const probe = await runTool(ffprobeBinary, ["-v", "error", "-show_format", "-of", "json", inputPath]);
  if (probe.code !== 0) throw new Error("Failed to read audio duration for chunk export.");
  const probeJson = JSON.parse(probe.stdout) as { format?: { duration?: string } };
  const durationSec = Number(probeJson.format?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Invalid audio duration.");

  const outputs: string[] = [];
  let chunkIndex = 1;
  for (let start = 0; start < durationSec; start += safeChunkDuration) {
    const end = Math.min(durationSec, start + safeChunkDuration);
    const outputPath = path.join(outputDir, `${baseName}-chunk-${chunkIndex}.${ext}`);
    await runFfmpeg(["-i", inputPath, "-ss", `${start}`, "-to", `${end}`, outputPath]);
    outputs.push(outputPath);
    chunkIndex += 1;
  }
  return outputs;
};

const parseDb = (raw: string) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export const analyzeAudio = async (inputPath: string) => {
  const probe = await runTool(ffprobeBinary, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    inputPath,
  ]);
  if (probe.code !== 0) throw new Error("Failed to analyze audio metadata.");
  const probeJson = JSON.parse(probe.stdout) as {
    streams?: Array<{ codec_type?: string; sample_rate?: string; channels?: number; bit_rate?: string }>;
    format?: { duration?: string; bit_rate?: string };
  };
  const audioStream = probeJson.streams?.find((s) => s.codec_type === "audio");
  const durationSec = Number(probeJson.format?.duration ?? 0);
  const sampleRate = Number(audioStream?.sample_rate ?? 0);
  const channels = Number(audioStream?.channels ?? 0);
  const bitRateKbps = Math.round(Number(audioStream?.bit_rate ?? probeJson.format?.bit_rate ?? 0) / 1000);

  const volume = await runTool(ffmpegBinary, ["-i", inputPath, "-af", "volumedetect", "-f", "null", "-"]);
  const meanMatch = volume.stderr.match(/mean_volume:\s*(-?\d+(\.\d+)?)\s*dB/i);
  const maxMatch = volume.stderr.match(/max_volume:\s*(-?\d+(\.\d+)?)\s*dB/i);
  const meanVolumeDb = meanMatch ? parseDb(meanMatch[1]) : null;
  const maxVolumeDb = maxMatch ? parseDb(maxMatch[1]) : null;

  const silence = await runTool(ffmpegBinary, [
    "-i",
    inputPath,
    "-af",
    "silencedetect=noise=-35dB:d=0.25",
    "-f",
    "null",
    "-",
  ]);
  const starts = [...silence.stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...silence.stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const silenceSegments = Math.min(starts.length, ends.length);
  let silenceTotalSec = 0;
  for (let i = 0; i < silenceSegments; i += 1) {
    silenceTotalSec += Math.max(0, ends[i] - starts[i]);
  }

  const estimatedNoiseLevel =
    meanVolumeDb === null ? "medium" : meanVolumeDb > -22 ? "high" : meanVolumeDb > -32 ? "medium" : "low";
  const clippingRisk = maxVolumeDb === null ? "medium" : maxVolumeDb > -0.8 ? "high" : maxVolumeDb > -3 ? "medium" : "low";

  const recommended = {
    noiseEnabled: estimatedNoiseLevel !== "low",
    noiseFloor: estimatedNoiseLevel === "high" ? -20 : -28,
    passType: "highpass" as const,
    passFrequency: 90,
    trimSilenceEnabled: silenceTotalSec > durationSec * 0.15,
    trimSilenceThreshold: -38,
    trimSilenceMinDuration: 0.2,
  };

  return {
    durationSec,
    sampleRate,
    channels,
    bitRateKbps,
    meanVolumeDb,
    maxVolumeDb,
    silenceSegments,
    silenceTotalSec,
    estimatedNoiseLevel,
    clippingRisk,
    recommended,
  };
};
