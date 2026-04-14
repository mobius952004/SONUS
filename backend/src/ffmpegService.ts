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

/** Explicit MP3 encoder avoids muxer/codec mismatches across FFmpeg builds. */
const audioEncodeArgsForOutput = (outputPath: string): string[] =>
  outputPath.toLowerCase().endsWith(".mp3") ? ["-c:a", "libmp3lame", "-q:a", "4"] : [];

export const getMediaDurationSec = async (inputPath: string): Promise<number> => {
  const probe = await runTool(ffprobeBinary, ["-v", "error", "-show_format", "-of", "json", inputPath]);
  if (probe.code !== 0) throw new Error("Failed to read audio duration.");
  let probeJson: { format?: { duration?: string } };
  try {
    probeJson = JSON.parse(probe.stdout) as { format?: { duration?: string } };
  } catch {
    throw new Error("Invalid duration metadata.");
  }
  const durationSec = Number(probeJson.format?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Invalid audio duration.");
  return durationSec;
};

const normalizeRegion = (r: Region, durationSec: number): { start: number; end: number } | null => {
  const start = Number(r.start);
  const end = Number(r.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.max(0, start);
  const e = Math.min(durationSec, end);
  if (!(e > s)) return null;
  return { start: s, end: e };
};

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
  await runFfmpeg(["-i", inputPath, ...audioEncodeArgsForOutput(outputPath), outputPath]);
};

export const exportSelectedRegions = async (inputPath: string, outputPath: string, regions: Region[]) => {
  await ensureDir(path.dirname(outputPath));
  const durationSec = await getMediaDurationSec(inputPath);
  const normalized = regions
    .map((r) => normalizeRegion(r, durationSec))
    .filter((x): x is { start: number; end: number } => x !== null)
    .sort((a, b) => a.start - b.start);
  if (!normalized.length) throw new Error("No valid regions for selected export.");
  const filterParts = normalized.map(
    (region, index) => `[0:a]atrim=start=${region.start}:end=${region.end},asetpts=PTS-STARTPTS[a${index}]`,
  );
  const concatInputs = normalized.map((_, index) => `[a${index}]`).join("");
  const filterComplex = `${filterParts.join(";")};${concatInputs}concat=n=${normalized.length}:v=0:a=1[out]`;
  await runFfmpeg([
    "-i",
    inputPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    ...audioEncodeArgsForOutput(outputPath),
    outputPath,
  ]);
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
  const durationSec = await getMediaDurationSec(inputPath);

  const clamped = removeRegions
    .map((r) => normalizeRegion(r, durationSec))
    .filter((x): x is { start: number; end: number } => x !== null);

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
  await runFfmpeg([
    "-i",
    inputPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    ...audioEncodeArgsForOutput(outputPath),
    outputPath,
  ]);
};

export const exportChunks = async (inputPath: string, outputDir: string, baseName: string, ext: "wav" | "mp3", regions: Region[]) => {
  await ensureDir(outputDir);
  const durationSec = await getMediaDurationSec(inputPath);
  const validRegions = regions
    .map((r) => normalizeRegion(r, durationSec))
    .filter((x): x is { start: number; end: number } => x !== null)
    .sort((a, b) => a.start - b.start);
  if (!validRegions.length) throw new Error("No valid regions for chunk export.");
  const outputs: string[] = [];
  for (let i = 0; i < validRegions.length; i += 1) {
    const region = validRegions[i];
    const outputPath = path.join(outputDir, `${baseName}-chunk-${i + 1}.${ext}`);
    await runFfmpeg([
      "-ss",
      `${region.start}`,
      "-i",
      inputPath,
      "-t",
      `${region.end - region.start}`,
      ...audioEncodeArgsForOutput(outputPath),
      outputPath,
    ]);
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
  const durationSec = await getMediaDurationSec(inputPath);

  const outputs: string[] = [];
  let chunkIndex = 1;
  for (let start = 0; start < durationSec; start += safeChunkDuration) {
    const end = Math.min(durationSec, start + safeChunkDuration);
    const outputPath = path.join(outputDir, `${baseName}-chunk-${chunkIndex}.${ext}`);
    await runFfmpeg([
      "-ss",
      `${start}`,
      "-i",
      inputPath,
      "-t",
      `${end - start}`,
      ...audioEncodeArgsForOutput(outputPath),
      outputPath,
    ]);
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
  let probeJson: {
    streams?: Array<{ codec_type?: string; sample_rate?: string; channels?: number; bit_rate?: string }>;
    format?: { duration?: string; bit_rate?: string };
  };
  try {
    probeJson = JSON.parse(probe.stdout) as typeof probeJson;
  } catch {
    throw new Error("Invalid analysis metadata.");
  }
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

/* ------------------------------------------------------------------ */
/*  P0 Feature 1: LUFS Loudness Normalization (EBU R128 / loudnorm)   */
/* ------------------------------------------------------------------ */

export const measureLoudness = async (inputPath: string): Promise<{ integratedLufs: number; truePeakDb: number; lra: number }> => {
  const result = await runTool(ffmpegBinary, [
    "-i", inputPath,
    "-af", "loudnorm=print_format=json",
    "-f", "null", "-",
  ]);
  // loudnorm prints JSON to stderr
  const jsonMatch = result.stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!jsonMatch) throw new Error("Failed to measure loudness.");
  let parsed: { input_i?: string; input_tp?: string; input_lra?: string };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch {
    throw new Error("Invalid loudness measurement data.");
  }
  return {
    integratedLufs: Number(parsed.input_i ?? -24),
    truePeakDb: Number(parsed.input_tp ?? -1),
    lra: Number(parsed.input_lra ?? 7),
  };
};

export const normalizeLoudness = async (
  inputPath: string,
  outputPath: string,
  targetLufs: number,
  truePeakLimit: number = -1.0,
): Promise<void> => {
  await ensureDir(path.dirname(outputPath));
  const safeLufs = Math.max(-70, Math.min(-5, targetLufs));
  const safePeak = Math.max(-10, Math.min(0, truePeakLimit));

  // Two-pass loudnorm: first measure, then normalize with precise values
  const measurement = await measureLoudness(inputPath);
  await runFfmpeg([
    "-i", inputPath,
    "-af", `loudnorm=I=${safeLufs}:TP=${safePeak}:LRA=11:measured_I=${measurement.integratedLufs}:measured_TP=${measurement.truePeakDb}:measured_LRA=${measurement.lra}:linear=true`,
    "-ar", "16000",
    "-ac", "1",
    outputPath,
  ]);
};

/* ------------------------------------------------------------------ */
/*  P0 Feature 2: VAD Auto-Segmentation (silencedetect inversion)     */
/* ------------------------------------------------------------------ */

export type DetectedRegion = {
  start: number;
  end: number;
  durationSec: number;
};

export const detectSpeechRegions = async (
  inputPath: string,
  silenceThresholdDb: number = -35,
  minSilenceDurationSec: number = 0.4,
  minSpeechDurationSec: number = 0.3,
): Promise<DetectedRegion[]> => {
  const durationSec = await getMediaDurationSec(inputPath);
  const safeThreshold = Math.max(-80, Math.min(-10, silenceThresholdDb));
  const safeSilDur = Math.max(0.1, Math.min(5, minSilenceDurationSec));

  const result = await runTool(ffmpegBinary, [
    "-i", inputPath,
    "-af", `silencedetect=noise=${safeThreshold}dB:d=${safeSilDur}`,
    "-f", "null", "-",
  ]);

  const silenceStarts = [...result.stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const silenceEnds = [...result.stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const silenceCount = Math.min(silenceStarts.length, silenceEnds.length);

  // Build silence intervals
  const silenceIntervals: { start: number; end: number }[] = [];
  for (let i = 0; i < silenceCount; i++) {
    silenceIntervals.push({ start: silenceStarts[i], end: silenceEnds[i] });
  }
  // Handle if file starts/ends with silence that silencedetect reports as end before start
  // (silencedetect can emit silence_end before the first silence_start if audio starts with silence)
  if (silenceEnds.length > silenceStarts.length) {
    // Audio started with silence; first silence_end has no matching start
    silenceIntervals.unshift({ start: 0, end: silenceEnds[0] });
  }

  // Invert silence intervals to get speech intervals
  const speechRegions: DetectedRegion[] = [];
  let cursor = 0;

  // Sort silence intervals
  silenceIntervals.sort((a, b) => a.start - b.start);

  for (const si of silenceIntervals) {
    if (si.start > cursor) {
      const dur = si.start - cursor;
      if (dur >= minSpeechDurationSec) {
        speechRegions.push({ start: cursor, end: si.start, durationSec: dur });
      }
    }
    cursor = Math.max(cursor, si.end);
  }
  // Trailing speech after last silence
  if (cursor < durationSec) {
    const dur = durationSec - cursor;
    if (dur >= minSpeechDurationSec) {
      speechRegions.push({ start: cursor, end: durationSec, durationSec: dur });
    }
  }

  // If no silence detected at all, entire file is one speech region
  if (silenceIntervals.length === 0 && durationSec > 0) {
    speechRegions.push({ start: 0, end: durationSec, durationSec });
  }

  return speechRegions;
};

/* ------------------------------------------------------------------ */
/*  P0 Feature 3: Dataset Export (chunks + manifest.json)             */
/* ------------------------------------------------------------------ */

export type DatasetChunkMeta = {
  filename: string;
  path: string;
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  format: string;
  label: string;
  speakerId: string;
};

export const exportDatasetChunks = async (
  inputPath: string,
  outputDir: string,
  baseName: string,
  ext: "wav" | "mp3",
  regions: Region[],
  label: string,
  speakerId: string,
  targetLufs: number | null,
): Promise<{ manifest: DatasetChunkMeta[]; manifestPath: string }> => {
  await ensureDir(outputDir);
  const durationSec = await getMediaDurationSec(inputPath);
  const validRegions = regions
    .map((r) => normalizeRegion(r, durationSec))
    .filter((x): x is { start: number; end: number } => x !== null)
    .sort((a, b) => a.start - b.start);
  if (!validRegions.length) throw new Error("No valid regions for dataset export.");

  const manifest: DatasetChunkMeta[] = [];

  for (let i = 0; i < validRegions.length; i += 1) {
    const region = validRegions[i];
    const chunkFilename = `${baseName}-chunk-${i + 1}.${ext}`;
    const outputPath = path.join(outputDir, chunkFilename);

    if (targetLufs !== null) {
      // Export chunk then normalize
      const tmpPath = path.join(outputDir, `_tmp_chunk_${i + 1}.wav`);
      await runFfmpeg([
        "-ss", `${region.start}`,
        "-i", inputPath,
        "-t", `${region.end - region.start}`,
        tmpPath,
      ]);
      await normalizeLoudness(tmpPath, outputPath, targetLufs);
      await fs.unlink(tmpPath).catch(() => undefined);
    } else {
      await runFfmpeg([
        "-ss", `${region.start}`,
        "-i", inputPath,
        "-t", `${region.end - region.start}`,
        ...audioEncodeArgsForOutput(outputPath),
        outputPath,
      ]);
    }

    // Probe the output chunk for real metadata
    const probe = await runTool(ffprobeBinary, [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", outputPath,
    ]);
    let probedRate = 16000;
    let probedChannels = 1;
    let probedDuration = region.end - region.start;
    if (probe.code === 0) {
      try {
        const pj = JSON.parse(probe.stdout) as {
          streams?: Array<{ sample_rate?: string; channels?: number }>;
          format?: { duration?: string };
        };
        const as = pj.streams?.find((s: any) => true);
        probedRate = Number(as?.sample_rate ?? probedRate);
        probedChannels = Number(as?.channels ?? probedChannels);
        probedDuration = Number(pj.format?.duration ?? probedDuration);
      } catch { /* use defaults */ }
    }

    manifest.push({
      filename: chunkFilename,
      path: chunkFilename,
      index: i + 1,
      startSec: region.start,
      endSec: region.end,
      durationSec: probedDuration,
      sampleRate: probedRate,
      channels: probedChannels,
      format: ext,
      label,
      speakerId,
    });
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    totalChunks: manifest.length,
    totalDurationSec: manifest.reduce((acc, c) => acc + c.durationSec, 0),
    label,
    speakerId,
    normalizedLufs: targetLufs,
    chunks: manifest,
  }, null, 2));

  return { manifest, manifestPath };
};
