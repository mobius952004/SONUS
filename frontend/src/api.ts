import axios from "axios";
import type { AudioAnalysis, DatasetChunkMeta, DetectedRegion, ExportFormat, ExportMode, FilterConfig, LoudnessMeasurement, Region } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export const api = axios.create({
  baseURL: API_BASE,
});

/** Prefer server message from JSON body (e.g. FFmpeg errors); avoids generic axios status text. */
export const getApiErrorMessage = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { message?: string } | undefined;
    if (typeof body?.message === "string" && body.message) return body.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Request failed.";
};

export const mediaUrl = (relativePath: string) => `${API_BASE}${relativePath}`;

export const uploadAudio = async (file: File) => {
  const form = new FormData();
  form.append("audio", file);
  const { data } = await api.post("/upload", form);
  return data as { fileId: string; path: string };
};

export const processAudio = async (fileId: string, filters: FilterConfig) => {
  const { data } = await api.post("/process", { fileId, filters });
  return data as { fileId: string; path: string };
};

export const exportAudio = async (
  fileId: string,
  regions: Region[],
  mode: ExportMode,
  format: ExportFormat,
  chunkDurationSec?: number,
) => {
  const { data } = await api.post("/export", { fileId, regions, mode, format, chunkDurationSec });
  return data as { files: Array<{ path: string; label: string }> };
};

export const analyzeAudio = async (fileId: string) => {
  const { data } = await api.post("/analyze", { fileId });
  return data as AudioAnalysis;
};

export const removeRangesFromAudio = async (fileId: string, regions: Region[]) => {
  const { data } = await api.post("/remove-ranges", { fileId, regions });
  return data as { fileId: string; path: string };
};

/** Keep only the given ranges (concatenated); replaces current file like other process operations. */
export const keepSelectedRanges = async (fileId: string, regions: Region[]) => {
  const { data } = await api.post("/keep-ranges", { fileId, regions });
  return data as { fileId: string; path: string };
};

/** P0: Normalize audio to target LUFS loudness */
export const normalizeAudio = async (fileId: string, targetLufs: number, truePeakLimit: number = -1) => {
  const { data } = await api.post("/normalize", { fileId, targetLufs, truePeakLimit });
  return data as { fileId: string; path: string };
};

/** P0: Measure current loudness (LUFS) */
export const measureAudioLoudness = async (fileId: string) => {
  const { data } = await api.post("/measure-loudness", { fileId });
  return data as LoudnessMeasurement;
};

/** P0: Auto-detect speech regions via VAD */
export const detectRegions = async (
  fileId: string,
  silenceThresholdDb?: number,
  minSilenceDurationSec?: number,
  minSpeechDurationSec?: number,
) => {
  const { data } = await api.post("/detect-regions", {
    fileId,
    silenceThresholdDb,
    minSilenceDurationSec,
    minSpeechDurationSec,
  });
  return data as { regions: DetectedRegion[] };
};

/** P0: Export dataset with chunks + manifest.json */
export const exportDataset = async (
  fileId: string,
  regions: Region[],
  format: ExportFormat,
  label: string,
  speakerId: string,
  targetLufs: number | null,
) => {
  const { data } = await api.post("/export-dataset", {
    fileId,
    regions,
    format,
    label,
    speakerId,
    targetLufs,
  });
  return data as {
    files: Array<{ path: string; label: string }>;
    manifest: DatasetChunkMeta[];
    manifestUrl: string;
  };
};
