import axios from "axios";
import type { AudioAnalysis, ExportFormat, ExportMode, FilterConfig, Region } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export const api = axios.create({
  baseURL: API_BASE,
});

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
