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
  exportChunks,
  exportChunksByDuration,
  exportFullAudio,
  exportSelectedRegions,
  removeTimeRangesFromAudio,
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
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/media", express.static(storageDir));
app.use("/samples", express.static(samplesDir));

const sourcePathFor = (fileId: string) => path.join(processedDir, `${fileId}.wav`);

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
    res.status(500).json({ message: (error as Error).message });
  }
});

app.post("/process", async (req, res) => {
  try {
    const { fileId, filters } = req.body as { fileId: string; filters: FiltersPayload };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const outputId = randomUUID();
    const outputPath = sourcePathFor(outputId);
    await applyFilters(inputPath, outputPath, filters);
    res.json({ fileId: outputId, path: `/media/processed/${outputId}.wav` });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const { fileId } = req.body as { fileId: string };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const analysis = await analyzeAudio(inputPath);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
});

app.post("/remove-ranges", async (req, res) => {
  try {
    const { fileId, regions } = req.body as { fileId: string; regions: Region[] };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const safeRegions = Array.isArray(regions) ? regions : [];
    const outputId = randomUUID();
    const outputPath = sourcePathFor(outputId);
    await removeTimeRangesFromAudio(inputPath, outputPath, safeRegions);
    res.json({ fileId: outputId, path: `/media/processed/${outputId}.wav` });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
});

app.post("/export", async (req, res) => {
  try {
    const { fileId, regions, mode, format, chunkDurationSec } = req.body as {
      fileId: string;
      regions: Region[];
      mode: "full" | "selected" | "chunks";
      format: "wav" | "mp3";
      chunkDurationSec?: number;
    };
    const inputPath = sourcePathFor(fileId);
    await fs.access(inputPath);
    const exportId = randomUUID();
    const safeRegions = Array.isArray(regions) ? regions : [];

    if (mode === "chunks") {
      const outDir = path.join(exportsDir, exportId);
      const chunkPaths =
        Number.isFinite(chunkDurationSec) && (chunkDurationSec ?? 0) > 0
          ? await exportChunksByDuration(inputPath, outDir, exportId, format, Number(chunkDurationSec))
          : await exportChunks(inputPath, outDir, exportId, format, safeRegions);
      const files = chunkPaths.map((item, idx) => ({
        path: `/media/exports/${exportId}/${path.basename(item)}`,
        label: `Chunk ${idx + 1}`,
      }));
      res.json({ files });
      return;
    }

    const outputPath = path.join(exportsDir, `${exportId}.${format}`);
    if (mode === "selected") {
      await exportSelectedRegions(inputPath, outputPath, safeRegions);
    } else {
      await exportFullAudio(inputPath, outputPath);
    }
    res.json({ files: [{ path: `/media/exports/${exportId}.${format}`, label: `Export ${format.toUpperCase()}` }] });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
});

ensurePaths().then(() => {
  app.listen(port, () => {
    console.log(`Audio backend listening at http://localhost:${port}`);
  });
});
