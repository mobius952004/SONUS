import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import {
  applyFilters,
  analyzeAudio,
  convertToStandardWav,
  detectSpeechRegions,
  exportChunks,
  exportChunksByDuration,
  exportDatasetChunks,
  exportFullAudio,
  exportSelectedRegions,
  measureLoudness,
  normalizeLoudness,
  removeTimeRangesFromAudio,
  resampleAudio,
  type FiltersPayload,
  type Region,
} from "./ffmpegService";

const app = express();
const port = 4000;
const rootDir = path.resolve(__dirname, "..");
const storageDir = path.join(rootDir, "storage");
const uploadsDir = path.join(storageDir, "uploads");
const processedDir = path.join(storageDir, "processed");
const exportsDir = path.join(storageDir, "exports");
const samplesDir = path.join(rootDir, "samples");

const allowedExt = new Set([".mp3", ".wav", ".amr", ".m4a", ".aac", ".ogg", ".webm"]);

const ensurePaths = async () => {
  await Promise.all([
    fs.mkdir(uploadsDir, { recursive: true }),
    fs.mkdir(processedDir, { recursive: true }),
    fs.mkdir(exportsDir, { recursive: true }),
    fs.mkdir(samplesDir, { recursive: true }),
  ]);
};

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use("/media", express.static(storageDir));
app.use("/samples", express.static(samplesDir));

const sourcePathFor = (fileId: string) => path.join(processedDir, `${fileId}.wav`);

/** Reject path traversal / arbitrary filenames (fileId must be a UUID from this app). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const readBodyFileId = (body: unknown): string => {
  if (typeof body !== "object" || body === null || !("fileId" in body)) {
    throw Object.assign(new Error("Missing file id."), { statusCode: 400 });
  }
  const id = (body as { fileId: unknown }).fileId;
  if (typeof id !== "string" || !UUID_V4_RE.test(id)) {
    throw Object.assign(new Error("Invalid file id."), { statusCode: 400 });
  }
  return id;
};

const sendError = (res: express.Response, error: unknown) => {
  const err = error as Error & { statusCode?: number };
  const status = typeof err.statusCode === "number" ? err.statusCode : 500;
  res.status(status).json({ message: err.message || "Request failed." });
};

/** Strip extension, replace non-alphanumeric chars, truncate — produces a safe file-name prefix. */
const sanitizeBaseName = (raw: string | undefined, fallback: string): string => {
  if (!raw || typeof raw !== "string") return fallback;
  const noExt = raw.replace(/\.[^.]+$/, "");            // drop extension
  const clean = noExt.replace(/[^a-zA-Z0-9_-]/g, "_");  // safe chars only
  const trimmed = clean.replace(/^_+|_+$/g, "");         // trim leading/trailing _
  return trimmed.length > 0 ? trimmed.slice(0, 60) : fallback;
};

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ message: "Missing file." });
      return;
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!allowedExt.has(ext)) {
      res.status(400).json({ message: "Unsupported format." });
      return;
    }
    const fileId = randomUUID();
    const standardizedPath = sourcePathFor(fileId);
    await convertToStandardWav(req.file.path, standardizedPath);
    await fs.unlink(req.file.path).catch(() => undefined);
    res.json({ fileId, path: `/media/processed/${fileId}.wav` });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/process", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { filters } = req.body as { filters: FiltersPayload };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const outputId = randomUUID();
    const outputPath = sourcePathFor(outputId);
    await applyFilters(inputPath, outputPath, filters);
    res.json({ fileId: outputId, path: `/media/processed/${outputId}.wav` });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const analysis = await analyzeAudio(inputPath);
    res.json(analysis);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/remove-ranges", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { regions } = req.body as { regions: Region[] };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const safeRegions = Array.isArray(regions) ? regions : [];
    const outputId = randomUUID();
    const outputPath = sourcePathFor(outputId);
    await removeTimeRangesFromAudio(inputPath, outputPath, safeRegions);
    res.json({ fileId: outputId, path: `/media/processed/${outputId}.wav` });
  } catch (error) {
    sendError(res, error);
  }
});

/** Concatenate selected time ranges into a new processed clip (crop / keep only). */
app.post("/keep-ranges", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { regions } = req.body as { regions: Region[] };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const safeRegions = Array.isArray(regions) ? regions : [];
    if (safeRegions.length === 0) {
      res.status(400).json({ message: "No regions provided." });
      return;
    }
    const outputId = randomUUID();
    const outputPath = sourcePathFor(outputId);
    await exportSelectedRegions(inputPath, outputPath, safeRegions);
    res.json({ fileId: outputId, path: `/media/processed/${outputId}.wav` });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/export", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { regions, mode, format, chunkDurationSec, originalFilename } = req.body as {
      regions: Region[];
      mode: "full" | "selected" | "chunks";
      format: "wav" | "mp3";
      chunkDurationSec?: number;
      originalFilename?: string;
    };
    if (format !== "wav" && format !== "mp3") {
      res.status(400).json({ message: "Invalid export format." });
      return;
    }
    if (mode !== "full" && mode !== "selected" && mode !== "chunks") {
      res.status(400).json({ message: "Invalid export mode." });
      return;
    }
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const exportId = randomUUID();
    const safeRegions = Array.isArray(regions) ? regions : [];

    if (mode === "chunks") {
      const useFixedDuration = Number.isFinite(chunkDurationSec) && (chunkDurationSec ?? 0) > 0;
      if (!useFixedDuration && safeRegions.length === 0) {
        res.status(400).json({ message: "Chunk export needs at least one checked range, or use fixed duration." });
        return;
      }
      const outDir = path.join(exportsDir, exportId);
      const baseName = sanitizeBaseName(originalFilename, exportId);
      const chunkPaths = useFixedDuration
        ? await exportChunksByDuration(inputPath, outDir, baseName, format, Number(chunkDurationSec))
        : await exportChunks(inputPath, outDir, baseName, format, safeRegions);
      const files = chunkPaths.map((item, idx) => ({
        path: `/media/exports/${exportId}/${path.basename(item)}`,
        label: `Chunk ${idx + 1}`,
      }));
      res.json({ files });
      return;
    }

    const outputPath = path.join(exportsDir, `${exportId}.${format}`);
    if (mode === "selected") {
      if (safeRegions.length === 0) {
        res.status(400).json({ message: "Selected export needs at least one checked range." });
        return;
      }
      await exportSelectedRegions(inputPath, outputPath, safeRegions);
    } else {
      await exportFullAudio(inputPath, outputPath);
    }
    res.json({ files: [{ path: `/media/exports/${exportId}.${format}`, label: `Export ${format.toUpperCase()}` }] });
  } catch (error) {
    sendError(res, error);
  }
});

/** P0: LUFS Loudness Normalization */
app.post("/normalize", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { targetLufs, truePeakLimit } = req.body as {
      targetLufs?: number;
      truePeakLimit?: number;
    };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const safeLufs = Number.isFinite(targetLufs) ? targetLufs! : -16;
    const safePeak = Number.isFinite(truePeakLimit) ? truePeakLimit! : -1;
    const outputId = randomUUID();
    const outputPath = sourcePathFor(outputId);
    await normalizeLoudness(inputPath, outputPath, safeLufs, safePeak);
    res.json({ fileId: outputId, path: `/media/processed/${outputId}.wav` });
  } catch (error) {
    sendError(res, error);
  }
});

/** P0: Measure current loudness (LUFS) without changing the file */
app.post("/measure-loudness", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const result = await measureLoudness(inputPath);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

/** P0: VAD auto-segmentation — detect speech regions */
app.post("/detect-regions", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { silenceThresholdDb, minSilenceDurationSec, minSpeechDurationSec } = req.body as {
      silenceThresholdDb?: number;
      minSilenceDurationSec?: number;
      minSpeechDurationSec?: number;
    };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const regions = await detectSpeechRegions(
      inputPath,
      Number.isFinite(silenceThresholdDb) ? silenceThresholdDb : undefined,
      Number.isFinite(minSilenceDurationSec) ? minSilenceDurationSec : undefined,
      Number.isFinite(minSpeechDurationSec) ? minSpeechDurationSec : undefined,
    );
    res.json({ regions });
  } catch (error) {
    sendError(res, error);
  }
});

/** P0: Dataset export — chunks + manifest.json */
app.post("/export-dataset", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { regions, format, label, speakerId, targetLufs } = req.body as {
      regions: Region[];
      format: "wav" | "mp3";
      label?: string;
      speakerId?: string;
      targetLufs?: number | null;
    };
    if (format !== "wav" && format !== "mp3") {
      res.status(400).json({ message: "Invalid export format." });
      return;
    }
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const safeRegions = Array.isArray(regions) ? regions : [];
    if (safeRegions.length === 0) {
      res.status(400).json({ message: "Dataset export needs at least one region." });
      return;
    }
    const exportId = randomUUID();
    const outDir = path.join(exportsDir, exportId);
    const { originalFilename: rawName } = req.body as { originalFilename?: string };
    const baseName = sanitizeBaseName(rawName, exportId);
    const safeLabel = typeof label === "string" ? label : "";
    const safeSpeakerId = typeof speakerId === "string" ? speakerId : "";
    const safeLufs = targetLufs !== null && Number.isFinite(targetLufs) ? targetLufs! : null;

    const { manifest } = await exportDatasetChunks(
      inputPath, outDir, baseName, format, safeRegions,
      safeLabel, safeSpeakerId, safeLufs,
    );

    const files = manifest.map((item) => ({
      path: `/media/exports/${exportId}/${item.filename}`,
      label: `Chunk ${item.index}`,
    }));
    files.push({
      path: `/media/exports/${exportId}/manifest.json`,
      label: "manifest.json",
    });
    res.json({
      files,
      manifest,
      manifestUrl: `/media/exports/${exportId}/manifest.json`,
    });
  } catch (error) {
    sendError(res, error);
  }
});

/** Resample audio to a target sample rate */
app.post("/resample", async (req, res) => {
  try {
    const fileId = readBodyFileId(req.body);
    const { targetSampleRate } = req.body as { targetSampleRate?: number };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const safeRate = Number.isFinite(targetSampleRate) ? targetSampleRate! : 16000;
    const outputId = randomUUID();
    const outputPath = sourcePathFor(outputId);
    await resampleAudio(inputPath, outputPath, safeRate);
    res.json({ fileId: outputId, path: `/media/processed/${outputId}.wav` });
  } catch (error) {
    sendError(res, error);
  }
});

/** Remove files / directories older than `maxAgeMs` from the given directory (non-recursive for files, recursive for sub-dirs). */
const cleanupOldFiles = async (dir: string, maxAgeMs: number) => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (entry.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fullPath);
          }
        }
      } catch { /* file may have been deleted concurrently */ }
    }
  } catch { /* directory may not exist yet */ }
};

const CLEANUP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

const runCleanup = async () => {
  await Promise.all([
    cleanupOldFiles(uploadsDir, CLEANUP_MAX_AGE_MS),
    cleanupOldFiles(processedDir, CLEANUP_MAX_AGE_MS),
    cleanupOldFiles(exportsDir, CLEANUP_MAX_AGE_MS),
  ]);
};

ensurePaths().then(() => {
  app.listen(port, () => {
    console.log(`Audio backend listening at http://localhost:${port}`);
  });
  // Run cleanup on startup and then periodically
  void runCleanup();
  setInterval(() => void runCleanup(), CLEANUP_INTERVAL_MS);
});
