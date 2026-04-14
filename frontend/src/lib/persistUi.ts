import type { AudioAnalysis, ExportFormat, ExportMode, FilterConfig, Region } from "../types";

const STORAGE_KEY = "sonus.editor.v1";

export type PersistedUiState = {
  version: 1;
  fileId: string;
  sourceUrl: string;
  regions: Region[];
  filters: FilterConfig;
  playbackRate: number;
  wavePreviewMode: "current" | "original" | "processed";
  processedPreviews: Array<{ fileId: string; path: string; createdAt: number }>;
  originalPreview: { fileId: string; path: string } | null;
  analysis: AudioAnalysis | null;
  selectedExportRegionIds: string[];
  zoom: number;
  exportMode: ExportMode;
  exportFormat: ExportFormat;
  chunkSplitMode: "selectedRanges" | "fixedDuration";
  fixedChunkDurationSec: number;
  lastUploadedFileName: string | null;
};

export const loadPersistedState = (): PersistedUiState | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedUiState;
    if (data.version !== 1 || typeof data.fileId !== "string" || typeof data.sourceUrl !== "string") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
};

export const savePersistedState = (state: PersistedUiState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
};

export const clearPersistedState = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
};
