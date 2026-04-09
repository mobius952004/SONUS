import { create } from "zustand";
import type { FilterConfig, Region } from "../types";

type Snapshot = {
  regions: Region[];
  filters: FilterConfig;
};

type EditorState = {
  fileId: string | null;
  sourceUrl: string | null;
  selectedRegionId: string | null;
  playbackRate: number;
  regions: Region[];
  filters: FilterConfig;
  past: Snapshot[];
  future: Snapshot[];
  setAudioFile: (fileId: string, sourceUrl: string) => void;
  setPlaybackRate: (rate: number) => void;
  setSelectedRegion: (id: string | null) => void;
  commitRegions: (regions: Region[]) => void;
  commitFilters: (filters: FilterConfig) => void;
  undo: () => void;
  redo: () => void;
};

const defaultFilters: FilterConfig = {
  passType: "none",
  passFrequency: 1000,
  echoEnabled: false,
  echoDelay: 120,
  echoDecay: 0.35,
  noiseEnabled: false,
  noiseFloor: -25,
  trimSilenceEnabled: false,
  trimSilenceThreshold: -40,
  trimSilenceMinDuration: 0.2,
};

const snapshotFrom = (state: EditorState): Snapshot => ({
  regions: state.regions,
  filters: state.filters,
});

export const useEditorStore = create<EditorState>((set, get) => ({
  fileId: null,
  sourceUrl: null,
  selectedRegionId: null,
  playbackRate: 1,
  regions: [],
  filters: defaultFilters,
  past: [],
  future: [],
  setAudioFile: (fileId, sourceUrl) =>
    set({
      fileId,
      sourceUrl,
      regions: [],
      selectedRegionId: null,
      past: [],
      future: [],
    }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
  setSelectedRegion: (id) => set({ selectedRegionId: id }),
  commitRegions: (regions) => {
    const state = get();
    set({
      regions,
      past: [...state.past, snapshotFrom(state)],
      future: [],
    });
  },
  commitFilters: (filters) => {
    const state = get();
    set({
      filters,
      past: [...state.past, snapshotFrom(state)],
      future: [],
    });
  },
  undo: () => {
    const state = get();
    if (state.past.length === 0) return;
    const previous = state.past[state.past.length - 1];
    set({
      regions: previous.regions,
      filters: previous.filters,
      past: state.past.slice(0, -1),
      future: [snapshotFrom(state), ...state.future],
    });
  },
  redo: () => {
    const state = get();
    if (state.future.length === 0) return;
    const [next, ...rest] = state.future;
    set({
      regions: next.regions,
      filters: next.filters,
      past: [...state.past, snapshotFrom(state)],
      future: rest,
    });
  },
}));
