import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import {
  analyzeAudio,
  detectRegions,
  exportAudio,
  exportDataset,
  getApiErrorMessage,
  keepSelectedRanges,
  measureAudioLoudness,
  mediaUrl,
  normalizeAudio,
  processAudio,
  removeRangesFromAudio,
  resampleAudio,
  uploadAudio,
} from "./api";
import { hasOverlap, isValidRange, nextRegionWindow, withUpdatedRegion } from "./lib/regions";
import { clearPersistedState, loadPersistedState, savePersistedState } from "./lib/persistUi";
import { defaultFilters, useEditorStore } from "./store/editorStore";
import type { AudioAnalysis, DatasetChunkMeta, ExportFormat, ExportMode, LoudnessMeasurement, Region } from "./types";

const ACCEPT_TYPES = ".mp3,.wav,.amr,.m4a,.aac,.ogg,.webm";
const MAX_FILE_SIZE = 200 * 1024 * 1024;
type BatchItem = {
  id: string;
  name: string;
  originalFileId: string;
  currentFileId: string;
  currentPath: string;
  status: "uploaded" | "analyzed" | "cleaned" | "exported" | "error";
  analysis?: AudioAnalysis;
  lastExportPath?: string;
  error?: string;
};

function App() {
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const spectrogramRef = useRef<HTMLDivElement | null>(null);
  const signalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const spectrogramPluginRef = useRef<ReturnType<typeof SpectrogramPlugin.create> | null>(null);
  const dragSelectCleanupRef = useRef<(() => void) | null>(null);
  const hydratedRef = useRef(false);
  const lastUiTickRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showSpectrogram, setShowSpectrogram] = useState(false);
  /** When true, user can drag on the waveform to create new ranges (resize/drag existing regions always works). */
  const [waveformDrawEnabled, setWaveformDrawEnabled] = useState(false);
  const [lastUploadedFileName, setLastUploadedFileName] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(50);
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<ExportMode>("full");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("wav");
  const [chunkSplitMode, setChunkSplitMode] = useState<"selectedRanges" | "fixedDuration">("selectedRanges");
  const [fixedChunkDurationSec, setFixedChunkDurationSec] = useState(30);
  const [exports, setExports] = useState<Array<{ path: string; label: string }>>([]);
  const [autoDownloadOnExport, setAutoDownloadOnExport] = useState(true);
  const [openPreviewOnExport, setOpenPreviewOnExport] = useState(true);
  const [processedPreviews, setProcessedPreviews] = useState<Array<{ fileId: string; path: string; createdAt: number }>>([]);
  const [originalPreview, setOriginalPreview] = useState<{ fileId: string; path: string } | null>(null);
  const [wavePreviewMode, setWavePreviewMode] = useState<"current" | "original" | "processed">("current");
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [selectedExportRegionIds, setSelectedExportRegionIds] = useState<string[]>([]);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchExportFormat, setBatchExportFormat] = useState<ExportFormat>("wav");
  const [fileInputKey, setFileInputKey] = useState(0);
  const originalAudioRef = useRef<HTMLAudioElement | null>(null);
  const processedAudioRef = useRef<HTMLAudioElement | null>(null);

  // P0: LUFS Normalization state
  const [loudness, setLoudness] = useState<LoudnessMeasurement | null>(null);
  const [targetLufs, setTargetLufs] = useState(-16);
  const [truePeakLimit, setTruePeakLimit] = useState(-1);

  // P0: VAD Auto-Segmentation state
  const [vadSilenceThreshold, setVadSilenceThreshold] = useState(-35);
  const [vadMinSilenceDuration, setVadMinSilenceDuration] = useState(0.4);
  const [vadMinSpeechDuration, setVadMinSpeechDuration] = useState(0.3);

  // P0: Dataset Export state
  const [datasetLabel, setDatasetLabel] = useState<"ai" | "human" | "">("human");
  const [datasetSpeakerId, setDatasetSpeakerId] = useState("");
  const [datasetNormalize, setDatasetNormalize] = useState(true);
  const [datasetTargetLufs, setDatasetTargetLufs] = useState(-16);
  const [datasetExportFormat, setDatasetExportFormat] = useState<ExportFormat>("wav");
  const [datasetExports, setDatasetExports] = useState<Array<{ path: string; label: string }>>([]);
  const [datasetManifest, setDatasetManifest] = useState<DatasetChunkMeta[] | null>(null);

  // Resampling state
  const [resampleTargetRate, setResampleTargetRate] = useState(22050);

  const {
    fileId,
    sourceUrl,
    selectedRegionId,
    playbackRate,
    regions,
    filters,
    setAudioFile,
    updateFileId,
    setSelectedRegion,
    setPlaybackRate,
    commitRegions,
    commitFilters,
    undo,
    redo,
  } = useEditorStore();

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const saved = loadPersistedState();
    if (!saved?.fileId || !saved.sourceUrl) return;
    // Validate the persisted file still exists on the server before restoring
    fetch(saved.sourceUrl, { method: "HEAD" })
      .then((res) => {
        if (!res.ok) {
          clearPersistedState();
          return;
        }
        useEditorStore.setState({
          fileId: saved.fileId,
          sourceUrl: saved.sourceUrl,
          regions: saved.regions ?? [],
          filters: { ...defaultFilters, ...saved.filters },
          playbackRate: saved.playbackRate ?? 1,
          selectedRegionId: null,
          past: [],
          future: [],
        });
        setWavePreviewMode(saved.wavePreviewMode ?? "current");
        setProcessedPreviews(saved.processedPreviews ?? []);
        setOriginalPreview(saved.originalPreview ?? null);
        setAnalysis(saved.analysis ?? null);
        setSelectedExportRegionIds(saved.selectedExportRegionIds ?? []);
        setZoom(saved.zoom ?? 50);
        setExportMode(saved.exportMode ?? "full");
        setExportFormat(saved.exportFormat ?? "wav");
        setChunkSplitMode(saved.chunkSplitMode ?? "selectedRanges");
        setFixedChunkDurationSec(saved.fixedChunkDurationSec ?? 30);
        setLastUploadedFileName(saved.lastUploadedFileName ?? null);
      })
      .catch(() => {
        clearPersistedState();
      });
  }, []);

  useEffect(() => {
    if (!fileId || !sourceUrl) return;
    const id = window.setTimeout(() => {
      savePersistedState({
        version: 1,
        fileId,
        sourceUrl,
        regions,
        filters,
        playbackRate,
        wavePreviewMode,
        processedPreviews,
        originalPreview,
        analysis,
        selectedExportRegionIds,
        zoom,
        exportMode,
        exportFormat,
        chunkSplitMode,
        fixedChunkDurationSec,
        lastUploadedFileName,
      });
    }, 500);
    return () => window.clearTimeout(id);
  }, [
    fileId,
    sourceUrl,
    regions,
    filters,
    playbackRate,
    wavePreviewMode,
    processedPreviews,
    originalPreview,
    analysis,
    selectedExportRegionIds,
    zoom,
    exportMode,
    exportFormat,
    chunkSplitMode,
    fixedChunkDurationSec,
    lastUploadedFileName,
  ]);

  const drawSignal = (timeSec: number) => {
    const ws = waveSurferRef.current as any;
    const canvas = signalCanvasRef.current;
    if (!ws || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const decoded = ws.getDecodedData?.() as AudioBuffer | null;
    if (!decoded) return;
    const channel = decoded.getChannelData(0);
    const width = canvas.width;
    const height = canvas.height;
    const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let x = 0; x < width; x += 1) {
      const idx = x * samplesPerPixel;
      let sum = 0;
      for (let i = 0; i < samplesPerPixel && idx + i < channel.length; i += 1) {
        sum += channel[idx + i];
      }
      const avg = sum / samplesPerPixel;
      const y = (1 - (avg + 1) / 2) * height;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const durationSec = decoded.duration || 0;
    if (durationSec > 0) {
      const x = Math.max(0, Math.min(width, (timeSec / durationSec) * width));
      ctx.strokeStyle = "#f43f5e";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  };

  useEffect(() => {
    if (!waveformRef.current || !timelineRef.current || waveSurferRef.current) return;
    const regionsPlugin = RegionsPlugin.create();
    regionsPluginRef.current = regionsPlugin;
    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "#94a3b8",
      progressColor: "#0f172a",
      cursorColor: "#ef4444",
      minPxPerSec: 50,
      height: 160,
      normalize: true,
      plugins: [regionsPlugin, TimelinePlugin.create({ container: timelineRef.current })],
    });
    waveSurferRef.current = ws;

    ws.on("finish", () => setIsPlaying(false));
    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("timeupdate", (time) => {
      const now = performance.now();
      if (now - lastUiTickRef.current > 120) {
        setCurrentTime(time);
        lastUiTickRef.current = now;
      }
      drawSignal(time);
    });
    ws.on("ready", () => {
      setDuration(ws.getDuration());
      drawSignal(0);
    });

    regionsPlugin.on("region-clicked", (region: any, e: MouseEvent) => {
      e.stopPropagation();
      setSelectedRegion(region.id);
    });

    regionsPlugin.on("region-updated", (region: any) => {
      const updated: Region = {
        id: region.id,
        start: region.start,
        end: region.end,
      };
      const proposal = withUpdatedRegion(useEditorStore.getState().regions, updated);
      if (!isValidRange(updated.start, updated.end) || hasOverlap(proposal)) {
        region.setOptions({
          start: useEditorStore.getState().regions.find((r) => r.id === region.id)?.start ?? region.start,
          end: useEditorStore.getState().regions.find((r) => r.id === region.id)?.end ?? region.end,
        });
        setErrorModal("Overlapping ranges are not allowed");
        return;
      }
      commitRegions(proposal);
    });
    const unsubRegionCreated = regionsPlugin.on("region-created", (region: any) => {
      const state = useEditorStore.getState();
      if (state.regions.some((r) => r.id === region.id)) {
        return;
      }
      const created: Region = { id: region.id, start: region.start, end: region.end };
      const next = [...state.regions, created];
      if (!isValidRange(created.start, created.end) || hasOverlap(next)) {
        region.remove();
        setErrorModal("Overlapping ranges are not allowed. Adjust or remove an existing range.");
        return;
      }
      commitRegions(next);
      setSelectedExportRegionIds((prev) => [...prev, created.id]);
      setSelectedRegion(created.id);
    });
    regionsPlugin.on("region-update", (region: any) => {
      const proposal = withUpdatedRegion(useEditorStore.getState().regions, {
        id: region.id,
        start: region.start,
        end: region.end,
      });
      if (hasOverlap(proposal) || !isValidRange(region.start, region.end)) {
        const previous = useEditorStore.getState().regions.find((r) => r.id === region.id);
        if (previous) {
          region.setOptions({ start: previous.start, end: previous.end });
        }
      }
    });

    return () => {
      unsubRegionCreated();
      dragSelectCleanupRef.current?.();
      dragSelectCleanupRef.current = null;
      ws.destroy();
    };
  }, [commitRegions, setSelectedRegion]);

  useEffect(() => {
    const plugin = regionsPluginRef.current;
    if (!plugin) return;
    dragSelectCleanupRef.current?.();
    dragSelectCleanupRef.current = null;
    if (!waveformDrawEnabled) return;
    dragSelectCleanupRef.current = plugin.enableDragSelection({
      color: "rgba(59, 130, 246, 0.35)",
      drag: true,
      resize: true,
    });
    return () => {
      dragSelectCleanupRef.current?.();
      dragSelectCleanupRef.current = null;
    };
  }, [waveformDrawEnabled]);

  useEffect(() => {
    const ws = waveSurferRef.current;
    const el = spectrogramRef.current;
    if (!showSpectrogram) {
      if (spectrogramPluginRef.current && ws) {
        ws.unregisterPlugin(spectrogramPluginRef.current);
        spectrogramPluginRef.current = null;
      }
      return;
    }
    if (!ws || !el) return;
    if (spectrogramPluginRef.current) return;
    const sp = SpectrogramPlugin.create({
      container: el,
      labels: true,
      splitChannels: false,
      scale: "mel",
    });
    ws.registerPlugin(sp);
    spectrogramPluginRef.current = sp;
    requestAnimationFrame(() => {
      (ws as unknown as { emit?: (ev: string) => void }).emit?.("resize");
    });
    return () => {
      const w = waveSurferRef.current;
      if (w && spectrogramPluginRef.current) {
        w.unregisterPlugin(spectrogramPluginRef.current);
        spectrogramPluginRef.current = null;
      }
    };
  }, [showSpectrogram]);

  const latestProcessed = processedPreviews[0] ?? null;

  const activeWaveUrl =
    wavePreviewMode === "original"
      ? originalPreview
        ? mediaUrl(originalPreview.path)
        : sourceUrl
      : wavePreviewMode === "processed"
        ? latestProcessed
          ? mediaUrl(latestProcessed.path)
          : sourceUrl
        : sourceUrl;

  useEffect(() => {
    if (!activeWaveUrl || !waveSurferRef.current) return;
    const ws = waveSurferRef.current as any;
    ws.load(activeWaveUrl).catch((error: Error & { name?: string }) => {
      if (error?.name !== "AbortError") {
        setErrorModal(error.message || "Failed to load audio waveform.");
      }
    });
  }, [activeWaveUrl]);

  useEffect(() => {
    waveSurferRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  useEffect(() => {
    const ws = waveSurferRef.current;
    if (!ws || !duration) return;
    try {
      ws.zoom(zoom);
    } catch {
      /* no decoded data yet */
    }
  }, [zoom, duration, activeWaveUrl]);

  useEffect(() => {
    const plugin = regionsPluginRef.current;
    if (!plugin) return;
    const active = new Map(plugin.getRegions().map((region) => [region.id, region]));
    for (const region of regions) {
      const existing = active.get(region.id);
      if (existing) {
        existing.setOptions({ start: region.start, end: region.end });
        active.delete(region.id);
      } else {
        plugin.addRegion({
          ...region,
          drag: true,
          resize: true,
          color: region.id === selectedRegionId ? "rgba(15, 23, 42, 0.35)" : "rgba(59, 130, 246, 0.3)",
        });
      }
    }
    active.forEach((region) => region.remove());
    plugin.getRegions().forEach((region) =>
      region.setOptions({
        color: region.id === selectedRegionId ? "rgba(15, 23, 42, 0.35)" : "rgba(59, 130, 246, 0.3)",
      }),
    );
  }, [regions, selectedRegionId]);

  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  );

  const checkedRegionsForEdit = useMemo(
    () => regions.filter((region) => selectedExportRegionIds.includes(region.id)),
    [regions, selectedExportRegionIds],
  );

  useEffect(() => {
    setSelectedExportRegionIds((prev) => {
      // Only remove IDs for regions that no longer exist; don't auto-add new ones
      return prev.filter((id) => regions.some((r) => r.id === id));
    });
  }, [regions]);

  const onUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setErrorModal("Max file size is 200MB.");
      return;
    }
    setBusy("Uploading and standardizing...");
    try {
      const result = await uploadAudio(file);
      setAudioFile(result.fileId, mediaUrl(result.path));
      setOriginalPreview({ fileId: result.fileId, path: result.path });
      setWavePreviewMode("current");
      setExports([]);
      setProcessedPreviews([]);
      setAnalysis(null);
      setLastUploadedFileName(file.name);
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const addRegion = () => {
    const duration = waveSurferRef.current?.getDuration() ?? 0;
    if (!duration) return;
    const { start, end } = nextRegionWindow(regions, duration);
    commitRegions([...regions, { id: crypto.randomUUID(), start, end }]);
  };

  const removeRegion = () => {
    if (!selectedRegionId) return;
    commitRegions(regions.filter((region) => region.id !== selectedRegionId));
    setSelectedRegion(null);
  };

  const updateRegionField = (regionId: string, key: "start" | "end", value: number) => {
    const current = regions.find((region) => region.id === regionId);
    if (!current) return;
    const candidate = { ...current, [key]: value };
    if (!isValidRange(candidate.start, candidate.end)) {
      setErrorModal("Invalid range. End must be greater than start and times must be non-negative.");
      return;
    }
    const proposal = withUpdatedRegion(regions, candidate);
    if (hasOverlap(proposal)) {
      setErrorModal("Overlapping ranges are not allowed");
      return;
    }
    commitRegions(proposal);
  };

  const applyFilters = async () => {
    if (!fileId) return;
    setBusy("Applying filters...");
    try {
      const result = await processAudio(fileId, filters);
      updateFileId(result.fileId, mediaUrl(result.path));
      setExports([]);
      setProcessedPreviews((prev) => [{ fileId: result.fileId, path: result.path, createdAt: Date.now() }, ...prev]);
      setWavePreviewMode("current");
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const removeCheckedRangesFromAudio = async () => {
    if (!fileId || checkedRegionsForEdit.length === 0) return;
    setBusy("Removing checked ranges from audio...");
    try {
      const result = await removeRangesFromAudio(fileId, checkedRegionsForEdit);
      updateFileId(result.fileId, mediaUrl(result.path));
      setExports([]);
      setProcessedPreviews((prev) => [{ fileId: result.fileId, path: result.path, createdAt: Date.now() }, ...prev]);
      setWavePreviewMode("current");
      setAnalysis(null);
      // Clear regions so stale markers don't persist on the new (shorter) waveform
      commitRegions([]);
      setSelectedExportRegionIds([]);
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const cropToCheckedRanges = async () => {
    if (!fileId || checkedRegionsForEdit.length === 0) return;
    setBusy("Cropping to checked ranges...");
    try {
      const result = await keepSelectedRanges(fileId, checkedRegionsForEdit);
      updateFileId(result.fileId, mediaUrl(result.path));
      setExports([]);
      setProcessedPreviews((prev) => [{ fileId: result.fileId, path: result.path, createdAt: Date.now() }, ...prev]);
      setWavePreviewMode("current");
      setAnalysis(null);
      // Clear regions so stale markers don't persist on the new (cropped) waveform
      commitRegions([]);
      setSelectedExportRegionIds([]);
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  /** Download a file via fetch+blob to avoid cross-origin <a download> issues. */
  const downloadViaBlob = async (url: string, filename: string) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Fallback: open in new tab if blob download fails
      window.open(url, "_blank");
    }
  };

  const runExport = async () => {
    if (!fileId) return;
    const chosenRegions =
      exportMode === "full" ? [] : regions.filter((region) => selectedExportRegionIds.includes(region.id));
    const useFixedDuration = exportMode === "chunks" && chunkSplitMode === "fixedDuration";
    if (exportMode === "selected" && chosenRegions.length === 0) {
      setErrorModal("Selected export: check at least one range in the Range Editor, or choose Full edited audio.");
      return;
    }
    if (exportMode === "chunks" && !useFixedDuration && chosenRegions.length === 0) {
      setErrorModal("Chunk export: check at least one range, or switch to Auto-split by fixed duration.");
      return;
    }
    const previewWindow =
      openPreviewOnExport && exportMode !== "chunks" ? window.open("about:blank", "_blank") : null;
    setBusy("Exporting...");
    try {
      const result = await exportAudio(
        fileId,
        useFixedDuration ? [] : chosenRegions,
        exportMode,
        exportFormat,
        useFixedDuration ? fixedChunkDurationSec : undefined,
        lastUploadedFileName ?? undefined,
      );
      setExports(result.files);

      const singleOutput = result.files.length === 1;
      if (singleOutput && previewWindow && result.files[0]) {
        previewWindow.location.href = mediaUrl(result.files[0].path);
      } else if (previewWindow) {
        previewWindow.close();
      }

      if (autoDownloadOnExport && result.files.length > 0) {
        const first = result.files[0];
        const filename = first.path.split("/").pop() ?? `export-1.${exportFormat}`;
        await downloadViaBlob(mediaUrl(first.path), filename);
      }
    } catch (error) {
      if (previewWindow) previewWindow.close();
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runAnalysis = async () => {
    if (!fileId) return;
    setBusy("Analyzing audio artifacts...");
    try {
      const result = await analyzeAudio(fileId);
      setAnalysis(result);
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const applyRecommendedCleanup = () => {
    if (!analysis) return;
    commitFilters({
      ...filters,
      noiseEnabled: analysis.recommended.noiseEnabled,
      noiseFloor: analysis.recommended.noiseFloor,
      passType: analysis.recommended.passType,
      passFrequency: analysis.recommended.passFrequency,
      trimSilenceEnabled: analysis.recommended.trimSilenceEnabled,
      trimSilenceThreshold: analysis.recommended.trimSilenceThreshold,
      trimSilenceMinDuration: analysis.recommended.trimSilenceMinDuration,
    });
  };

  // --- P0: LUFS Normalization handlers ---
  const runMeasureLoudness = async () => {
    if (!fileId) return;
    setBusy("Measuring loudness (LUFS)...");
    try {
      const result = await measureAudioLoudness(fileId);
      setLoudness(result);
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runNormalizeLoudness = async () => {
    if (!fileId) return;
    setBusy(`Normalizing to ${targetLufs} LUFS...`);
    try {
      const result = await normalizeAudio(fileId, targetLufs, truePeakLimit);
      updateFileId(result.fileId, mediaUrl(result.path));
      setExports([]);
      setProcessedPreviews((prev) => [{ fileId: result.fileId, path: result.path, createdAt: Date.now() }, ...prev]);
      setWavePreviewMode("current");
      setLoudness(null); // re-measure after normalization
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  // --- P0: VAD Auto-Segmentation handler ---
  const runVadDetection = async () => {
    if (!fileId) return;
    setBusy("Detecting speech regions (VAD)...");
    try {
      const result = await detectRegions(fileId, vadSilenceThreshold, vadMinSilenceDuration, vadMinSpeechDuration);
      if (result.regions.length === 0) {
        setErrorModal("No speech regions detected. Try lowering the silence threshold or minimum duration.");
        return;
      }
      // Create editor regions from detected speech segments
      const newRegions: Region[] = result.regions.map((r) => ({
        id: crypto.randomUUID(),
        start: Math.round(r.start * 100) / 100,
        end: Math.round(r.end * 100) / 100,
      }));
      commitRegions(newRegions);
      setSelectedExportRegionIds(newRegions.map((r) => r.id));
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  // --- P0: Dataset Export handler ---
  const runDatasetExport = async () => {
    if (!fileId) return;
    const chosenRegions = regions.filter((r) => selectedExportRegionIds.includes(r.id));
    if (chosenRegions.length === 0) {
      setErrorModal("Dataset export needs at least one checked region. Use VAD detection or add regions manually.");
      return;
    }
    setBusy(`Exporting dataset (${chosenRegions.length} chunks)...`);
    try {
      const result = await exportDataset(
        fileId,
        chosenRegions,
        datasetExportFormat,
        datasetLabel,
        datasetSpeakerId,
        datasetNormalize ? datasetTargetLufs : null,
        lastUploadedFileName ?? undefined,
      );
      setDatasetExports(result.files);
      setDatasetManifest(result.manifest);
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  // --- Resample handler ---
  const runResample = async () => {
    if (!fileId) return;
    setBusy(`Resampling to ${resampleTargetRate} Hz...`);
    try {
      const result = await resampleAudio(fileId, resampleTargetRate);
      updateFileId(result.fileId, mediaUrl(result.path));
      setExports([]);
      setProcessedPreviews((prev) => [{ fileId: result.fileId, path: result.path, createdAt: Date.now() }, ...prev]);
      setWavePreviewMode("current");
      setAnalysis(null);
    } catch (error) {
      setErrorModal(getApiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onBatchUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setBusy(`Uploading batch (${files.length})...`);
    const nextItems: BatchItem[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        nextItems.push({
          id: crypto.randomUUID(),
          name: file.name,
          originalFileId: "",
          currentFileId: "",
          currentPath: "",
          status: "error",
          error: "File too large (>200MB).",
        });
        continue;
      }
      try {
        const uploaded = await uploadAudio(file);
        nextItems.push({
          id: crypto.randomUUID(),
          name: file.name,
          originalFileId: uploaded.fileId,
          currentFileId: uploaded.fileId,
          currentPath: uploaded.path,
          status: "uploaded",
        });
      } catch (error) {
        nextItems.push({
          id: crypto.randomUUID(),
          name: file.name,
          originalFileId: "",
          currentFileId: "",
          currentPath: "",
          status: "error",
          error: getApiErrorMessage(error),
        });
      }
    }
    setBatchItems((prev) => [...prev, ...nextItems]);
    setBusy(null);
  };

  const analyzeBatch = async () => {
    if (batchItems.length === 0) return;
    setBusy("Analyzing batch...");
    const updated: BatchItem[] = [];
    for (const item of batchItems) {
      if (item.status === "error" || !item.currentFileId) {
        updated.push(item);
        continue;
      }
      try {
        const a = await analyzeAudio(item.currentFileId);
        updated.push({ ...item, analysis: a, status: "analyzed" });
      } catch (error) {
        updated.push({ ...item, status: "error", error: getApiErrorMessage(error) });
      }
    }
    setBatchItems(updated);
    setBusy(null);
  };

  const autoCleanBatch = async () => {
    if (batchItems.length === 0) return;
    setBusy("Auto-cleaning batch...");
    const updated: BatchItem[] = [];
    for (const item of batchItems) {
      if (item.status === "error" || !item.currentFileId) {
        updated.push(item);
        continue;
      }
      try {
        const a = item.analysis ?? (await analyzeAudio(item.currentFileId));
        const processed = await processAudio(item.currentFileId, {
          ...defaultFilters,
          noiseEnabled: a.recommended.noiseEnabled,
          noiseFloor: a.recommended.noiseFloor,
          passType: a.recommended.passType,
          passFrequency: a.recommended.passFrequency,
          trimSilenceEnabled: a.recommended.trimSilenceEnabled,
          trimSilenceThreshold: a.recommended.trimSilenceThreshold,
          trimSilenceMinDuration: a.recommended.trimSilenceMinDuration,
        });
        updated.push({
          ...item,
          analysis: a,
          status: "cleaned",
          currentFileId: processed.fileId,
          currentPath: processed.path,
        });
      } catch (error) {
        updated.push({ ...item, status: "error", error: getApiErrorMessage(error) });
      }
    }
    setBatchItems(updated);
    setBusy(null);
  };

  const exportBatch = async () => {
    if (batchItems.length === 0) return;
    setBusy("Exporting batch...");
    const updated: BatchItem[] = [];
    for (const item of batchItems) {
      if (item.status === "error" || !item.currentFileId) {
        updated.push(item);
        continue;
      }
      try {
        const out = await exportAudio(item.currentFileId, [], "full", batchExportFormat);
        updated.push({ ...item, status: "exported", lastExportPath: out.files[0]?.path });
      } catch (error) {
        updated.push({ ...item, status: "error", error: getApiErrorMessage(error) });
      }
    }
    setBatchItems(updated);
    setBusy(null);
  };

  const syncAndPlay = (source: "original" | "processed") => {
    const original = originalAudioRef.current;
    const processed = processedAudioRef.current;
    if (!original || !processed) return;
    if (source === "original") {
      processed.currentTime = original.currentTime;
      void original.play();
      void processed.play();
      return;
    }
    original.currentTime = processed.currentTime;
    void original.play();
    void processed.play();
  };

  const pauseBoth = () => {
    originalAudioRef.current?.pause();
    processedAudioRef.current?.pause();
  };

  const clearSession = () => {
    clearPersistedState();
    useEditorStore.setState({
      fileId: null,
      sourceUrl: null,
      regions: [],
      filters: defaultFilters,
      selectedRegionId: null,
      playbackRate: 1,
      past: [],
      future: [],
    });
    setProcessedPreviews([]);
    setOriginalPreview(null);
    setAnalysis(null);
    setExports([]);
    setSelectedExportRegionIds([]);
    setBatchItems([]);
    setWavePreviewMode("current");
    setLastUploadedFileName(null);
    setShowSpectrogram(false);
    setWaveformDrawEnabled(false);
    setZoom(50);
    setFileInputKey((k) => k + 1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName;
      if (event.code === "Space" && tag !== "INPUT" && tag !== "TEXTAREA") {
        event.preventDefault();
        waveSurferRef.current?.playPause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="min-h-screen overflow-x-hidden bg-slate-100 p-4 text-slate-900 md:p-8">
      <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <section className="min-w-0 rounded-xl bg-white p-4 shadow">
          <h1 className="text-2xl font-semibold">Audio Signal Editor</h1>
          <p className="mt-1 text-sm text-slate-600">Non-destructive editing with waveform regions and FFmpeg processing.</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              key={fileInputKey}
              type="file"
              accept={ACCEPT_TYPES}
              onChange={onUpload}
              className="rounded border p-2 text-sm"
            />
            {lastUploadedFileName && (
              <span className="max-w-[min(100%,12rem)] truncate text-xs text-slate-600" title={lastUploadedFileName}>
                {lastUploadedFileName}
              </span>
            )}
            <button
              className="inline-flex min-w-28 items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-400"
              onClick={() => waveSurferRef.current?.playPause()}
              disabled={!sourceUrl}
            >
              <span className="mr-2">{isPlaying ? "||" : ">"}</span>
              {isPlaying ? "Pause" : "Play"}
            </button>
            <button className="btn" onClick={addRegion} disabled={!sourceUrl}>
              Add Range
            </button>
            <button
              type="button"
              className={`btn ${waveformDrawEnabled ? "!bg-slate-900 !text-white" : ""}`}
              onClick={() => setWaveformDrawEnabled((v) => !v)}
              disabled={!sourceUrl}
              title="When on, drag on the waveform to create a new range. Existing regions can always be dragged and resized."
            >
              {waveformDrawEnabled ? "Drawing ranges: on" : "Draw range on waveform"}
            </button>
            <button className="btn" onClick={removeRegion} disabled={!selectedRegionId}>
              Remove Range
            </button>
            <button
              className="btn !border-emerald-200 !bg-emerald-50 !text-emerald-900 hover:!bg-emerald-100"
              onClick={cropToCheckedRanges}
              disabled={!fileId || checkedRegionsForEdit.length === 0}
              title="Keep only the checked ranges (concatenated). Uses boxes in Range Editor."
            >
              Crop to checked ranges
            </button>
            <button
              className="btn !border-rose-200 !bg-rose-50 !text-rose-900 hover:!bg-rose-100"
              onClick={removeCheckedRangesFromAudio}
              disabled={!fileId || checkedRegionsForEdit.length === 0}
              title="Remove all checked ranges from the file. Uses boxes in Range Editor."
            >
              Remove checked ranges
            </button>
            <button className="btn" onClick={undo}>
              Undo
            </button>
            <button className="btn" onClick={redo}>
              Redo
            </button>
            <button type="button" className="btn text-xs text-slate-600" onClick={clearSession} title="Clear editor and saved browser state">
              Clear session
            </button>
          </div>

          <div className="mt-4 rounded border bg-slate-50 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
              <span>
                {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
              </span>
              <span>
                Space: play/pause · Turn on “Draw range on waveform” to paint a selection · Drag region edges to resize
              </span>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-600">Waveform source:</span>
              <button
                className={`btn ${wavePreviewMode === "current" ? "!bg-slate-900 !text-white" : ""}`}
                onClick={() => setWavePreviewMode("current")}
                disabled={!sourceUrl}
              >
                Editable Current
              </button>
              <button
                className={`btn ${wavePreviewMode === "original" ? "!bg-slate-900 !text-white" : ""}`}
                onClick={() => setWavePreviewMode("original")}
                disabled={!originalPreview}
              >
                Original
              </button>
              <button
                className={`btn ${wavePreviewMode === "processed" ? "!bg-slate-900 !text-white" : ""}`}
                onClick={() => setWavePreviewMode("processed")}
                disabled={!latestProcessed}
              >
                Latest Processed
              </button>
              {wavePreviewMode !== "current" && (
                <span className="text-xs text-amber-700">Preview mode active (range edits apply to current file).</span>
              )}
            </div>
            <div className="mb-2 flex items-center gap-2">
              <button className={`btn ${showSpectrogram ? "!bg-slate-900 !text-white" : ""}`} onClick={() => setShowSpectrogram((v) => !v)}>
                {showSpectrogram ? "Hide Spectrogram" : "Show Spectrogram"}
              </button>
              <span className="text-xs text-slate-500">Use spectrogram for noise/hum/hiss artifact inspection.</span>
            </div>
            <div ref={waveformRef} />
            <div ref={timelineRef} className="mt-2" />
            {showSpectrogram && (
              <div ref={spectrogramRef} className="mt-2 overflow-x-auto rounded border border-slate-200 bg-slate-950/[0.03]" />
            )}
            <div className="mt-3 overflow-hidden">
              <p className="mb-1 text-xs font-medium text-slate-600">1D Signal Visualization (oscilloscope)</p>
              <canvas ref={signalCanvasRef} width={1000} height={110} className="h-28 w-full rounded border border-slate-300" />
            </div>
            <label className="mt-3 block text-sm">
              Zoom: {zoom}
              <input
                type="range"
                min={10}
                max={300}
                value={zoom}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setZoom(next);
                  waveSurferRef.current?.zoom(next);
                }}
                className="w-full"
              />
            </label>
            <label className="mt-2 block text-sm">
              Playback speed: {playbackRate.toFixed(2)}x
              <input
                type="range"
                min={0.5}
                max={4}
                step={0.1}
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
                className="w-full"
              />
            </label>
          </div>
        </section>

        <section className="min-w-0 space-y-4">
          <div className="panel">
            <h2 className="panel-title">Range Editor</h2>
            <div className="mb-2 flex items-center gap-2">
              <button className="btn" onClick={() => setSelectedExportRegionIds(regions.map((r) => r.id))}>
                Select All for Export
              </button>
              <button className="btn" onClick={() => setSelectedExportRegionIds([])}>
                Select None
              </button>
            </div>
            <div className="max-h-80 space-y-2 overflow-y-auto rounded border border-slate-100 p-1">
              {regions.map((region) => (
                <div
                  key={region.id}
                  className={`rounded border p-2 ${region.id === selectedRegionId ? "border-slate-800 bg-slate-100" : "bg-white"}`}
                  onClick={() => setSelectedRegion(region.id)}
                >
                  <div className="text-xs text-slate-500">{region.id.slice(0, 8)}</div>
                  <label className="mt-1 flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={selectedExportRegionIds.includes(region.id)}
                      onChange={(e) => {
                        e.stopPropagation();
                        setSelectedExportRegionIds((prev) =>
                          prev.includes(region.id) ? prev.filter((id) => id !== region.id) : [...prev, region.id],
                        );
                      }}
                    />
                    Use for export, crop, and remove-checked
                  </label>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={region.start.toFixed(2)}
                      onChange={(e) => updateRegionField(region.id, "start", Number(e.target.value))}
                      className="field"
                    />
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={region.end.toFixed(2)}
                      onChange={(e) => updateRegionField(region.id, "end", Number(e.target.value))}
                      className="field"
                    />
                  </div>
                </div>
              ))}
              {regions.length === 0 && <p className="text-sm text-slate-500">No ranges yet.</p>}
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">Filters</h2>
            <div className="space-y-2 text-sm">
              <div>
                <label className="mr-2">Pass filter:</label>
                {(["none", "highpass", "lowpass"] as const).map((type) => (
                  <label key={type} className="mr-2">
                    <input
                      type="radio"
                      checked={filters.passType === type}
                      onChange={() => commitFilters({ ...filters, passType: type })}
                    />{" "}
                    {type}
                  </label>
                ))}
              </div>
              <label className="block">
                Frequency (Hz)
                <input
                  className="field mt-1"
                  type="number"
                  min={20}
                  max={20000}
                  value={filters.passFrequency}
                  onChange={(e) => commitFilters({ ...filters, passFrequency: Number(e.target.value) })}
                />
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  checked={filters.echoEnabled}
                  onChange={(e) => commitFilters({ ...filters, echoEnabled: e.target.checked })}
                />{" "}
                Echo cancellation / echo filter
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="field"
                  type="number"
                  value={filters.echoDelay}
                  onChange={(e) => commitFilters({ ...filters, echoDelay: Number(e.target.value) })}
                />
                <input
                  className="field"
                  type="number"
                  step={0.05}
                  value={filters.echoDecay}
                  onChange={(e) => commitFilters({ ...filters, echoDecay: Number(e.target.value) })}
                />
              </div>
              <label className="block">
                <input
                  type="checkbox"
                  checked={filters.noiseEnabled}
                  onChange={(e) => commitFilters({ ...filters, noiseEnabled: e.target.checked })}
                />{" "}
                Noise reduction (afftdn)
              </label>
              <label className="block">
                Noise floor (dB)
                <input
                  className="field mt-1"
                  type="number"
                  value={filters.noiseFloor}
                  onChange={(e) => commitFilters({ ...filters, noiseFloor: Number(e.target.value) })}
                />
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  checked={filters.trimSilenceEnabled}
                  onChange={(e) => commitFilters({ ...filters, trimSilenceEnabled: e.target.checked })}
                />{" "}
                Trim silence/artifacts
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="field"
                  type="number"
                  step={0.1}
                  value={filters.trimSilenceThreshold}
                  onChange={(e) => commitFilters({ ...filters, trimSilenceThreshold: Number(e.target.value) })}
                />
                <input
                  className="field"
                  type="number"
                  step={0.05}
                  min={0.05}
                  value={filters.trimSilenceMinDuration}
                  onChange={(e) => commitFilters({ ...filters, trimSilenceMinDuration: Number(e.target.value) })}
                />
              </div>
              <button className="btn w-full" onClick={applyFilters} disabled={!fileId}>
                Apply Filters
              </button>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">Audio Analyzer</h2>
            <button className="btn w-full" onClick={runAnalysis} disabled={!fileId}>
              Analyze Audio
            </button>
            {!analysis ? (
              <p className="mt-2 text-sm text-slate-500">
                Analyze to detect silence, clipping risk, loudness profile, and cleanup recommendations.
              </p>
            ) : (
              <div className="mt-2 space-y-2 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded border p-2">Duration: {analysis.durationSec.toFixed(2)}s</div>
                  <div className="rounded border p-2">Rate: {analysis.sampleRate} Hz</div>
                  <div className="rounded border p-2">Channels: {analysis.channels}</div>
                  <div className="rounded border p-2">Bitrate: {analysis.bitRateKbps} kbps</div>
                  <div className="rounded border p-2">
                    Mean Volume: {analysis.meanVolumeDb === null ? "N/A" : `${analysis.meanVolumeDb.toFixed(1)} dB`}
                  </div>
                  <div className="rounded border p-2">
                    Max Volume: {analysis.maxVolumeDb === null ? "N/A" : `${analysis.maxVolumeDb.toFixed(1)} dB`}
                  </div>
                  <div className="rounded border p-2">Silence Segments: {analysis.silenceSegments}</div>
                  <div className="rounded border p-2">Silence Total: {analysis.silenceTotalSec.toFixed(2)}s</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded border p-2">Noise Level: {analysis.estimatedNoiseLevel}</div>
                  <div className="rounded border p-2">Clipping Risk: {analysis.clippingRisk}</div>
                </div>
                <button className="btn w-full" onClick={applyRecommendedCleanup}>
                  Apply Recommended Cleanup Settings
                </button>
              </div>
            )}
          </div>

          <div className="panel">
            <h2 className="panel-title">Processed Output Preview</h2>
            {processedPreviews.length === 0 ? (
              <p className="text-sm text-slate-500">No processed preview yet. Apply filters to generate one.</p>
            ) : (
              <div className="space-y-3">
                {processedPreviews.map((item, index) => (
                  <div key={item.fileId} className="rounded border border-slate-200 p-2">
                    <div className="mb-2 text-xs text-slate-500">Version {processedPreviews.length - index}</div>
                    <audio controls className="w-full" src={mediaUrl(item.path)} />
                    <button className="btn mt-2 w-full" onClick={() => setAudioFile(item.fileId, mediaUrl(item.path))}>
                      Load This Version in Editor
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <h2 className="panel-title">A/B Compare</h2>
            {originalPreview && latestProcessed ? (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded border border-slate-200 p-2">
                    <p className="mb-1 text-xs font-medium text-slate-600">Original</p>
                    <audio ref={originalAudioRef} controls className="w-full" src={mediaUrl(originalPreview.path)} />
                    <button className="btn mt-2 w-full" onClick={() => syncAndPlay("original")}>
                      Sync + Play from Original
                    </button>
                  </div>
                  <div className="rounded border border-slate-200 p-2">
                    <p className="mb-1 text-xs font-medium text-slate-600">Latest Processed</p>
                    <audio ref={processedAudioRef} controls className="w-full" src={mediaUrl(latestProcessed.path)} />
                    <button className="btn mt-2 w-full" onClick={() => syncAndPlay("processed")}>
                      Sync + Play from Processed
                    </button>
                  </div>
                </div>
                <button className="btn w-full" onClick={pauseBoth}>
                  Pause Both
                </button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Upload audio and apply at least one filter to enable original vs processed comparison.
              </p>
            )}
          </div>

          <div className="panel">
            <h2 className="panel-title">Export</h2>
            <div className="space-y-2 text-sm">
              <p className="text-xs text-slate-500">
                Selected ranges: {selectedExportRegionIds.length} / {regions.length}
              </p>
              <select className="field" value={exportMode} onChange={(e) => setExportMode(e.target.value as ExportMode)}>
                <option value="full">Full edited audio</option>
                <option value="selected">Selected regions only</option>
                <option value="chunks">Split into chunks</option>
              </select>
              {exportMode === "chunks" && (
                <>
                  <select
                    className="field"
                    value={chunkSplitMode}
                    onChange={(e) => setChunkSplitMode(e.target.value as "selectedRanges" | "fixedDuration")}
                  >
                    <option value="selectedRanges">Use selected ranges as chunks</option>
                    <option value="fixedDuration">Auto-split by fixed duration</option>
                  </select>
                  {chunkSplitMode === "fixedDuration" && (
                    <label className="block">
                      Chunk duration (seconds)
                      <input
                        className="field mt-1"
                        type="number"
                        min={1}
                        step={1}
                        value={fixedChunkDurationSec}
                        onChange={(e) => setFixedChunkDurationSec(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                  )}
                </>
              )}
              <select className="field" value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportFormat)}>
                <option value="wav">.wav</option>
                <option value="mp3">.mp3</option>
              </select>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={autoDownloadOnExport} onChange={(e) => setAutoDownloadOnExport(e.target.checked)} />
                Auto-download all exported files/chunks
              </label>
              <p className="text-xs text-slate-600">
                After chunk export, every part is listed below—use Download or Open for each. Browsers often allow only one automatic download unless you allow multiple downloads for this site.
              </p>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={openPreviewOnExport} onChange={(e) => setOpenPreviewOnExport(e.target.checked)} />
                Open preview in new tab (single-file exports only; not used for chunks)
              </label>
              <button className="btn w-full" onClick={runExport} disabled={!fileId}>
                Export Audio
              </button>
              {selectedRegion && (
                <button className="btn w-full" onClick={() => waveSurferRef.current?.play(selectedRegion.start, selectedRegion.end)}>
                  Play selected region
                </button>
              )}
            </div>
            {exports.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium text-slate-700">Exported files ({exports.length})</p>
                <ul className="space-y-2 text-sm">
                  {exports.map((item) => {
                    const filename = item.path.split("/").pop() ?? "export";
                    return (
                      <li
                        key={item.path}
                        className="flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-white px-2 py-2"
                      >
                        <span className="min-w-0 flex-1 font-medium text-slate-800">{item.label}</span>
                        <button
                          type="button"
                          className="inline-flex shrink-0 items-center rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100"
                          onClick={() => downloadViaBlob(mediaUrl(item.path), filename)}
                        >
                          Download
                        </button>
                        <a className="text-xs text-blue-700 underline" href={mediaUrl(item.path)} target="_blank" rel="noreferrer">
                          Open in tab
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <div className="panel">
            <h2 className="panel-title">Batch Dataset Pipeline</h2>
            <div className="space-y-2 text-sm">
              <input type="file" multiple accept={ACCEPT_TYPES} onChange={onBatchUpload} className="rounded border p-2 text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <button className="btn" onClick={analyzeBatch} disabled={batchItems.length === 0}>
                  Analyze All
                </button>
                <button className="btn" onClick={autoCleanBatch} disabled={batchItems.length === 0}>
                  Auto-Clean All
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select className="field" value={batchExportFormat} onChange={(e) => setBatchExportFormat(e.target.value as ExportFormat)}>
                  <option value="wav">.wav</option>
                  <option value="mp3">.mp3</option>
                </select>
                <button className="btn" onClick={exportBatch} disabled={batchItems.length === 0}>
                  Export All
                </button>
              </div>
              <div className="max-h-64 space-y-2 overflow-auto rounded border p-2">
                {batchItems.length === 0 ? (
                  <p className="text-slate-500">No batch files loaded.</p>
                ) : (
                  batchItems.map((item) => (
                    <div key={item.id} className="rounded border border-slate-200 p-2">
                      <div className="text-xs font-medium">{item.name}</div>
                      <div className="text-xs text-slate-500">Status: {item.status}</div>
                      {item.error && <div className="text-xs text-red-600">{item.error}</div>}
                      {item.lastExportPath && (
                        <a className="text-xs text-blue-700 underline" href={mediaUrl(item.lastExportPath)} target="_blank" rel="noreferrer">
                          Download Export
                        </a>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">LUFS Loudness Normalization</h2>
            <div className="space-y-2 text-sm">
              <button className="btn w-full" onClick={runMeasureLoudness} disabled={!fileId}>
                Measure Current Loudness
              </button>
              {loudness && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded border p-2 text-center">
                    <div className="text-xs text-slate-500">Integrated</div>
                    <div className="font-medium">{loudness.integratedLufs.toFixed(1)} LUFS</div>
                  </div>
                  <div className="rounded border p-2 text-center">
                    <div className="text-xs text-slate-500">True Peak</div>
                    <div className="font-medium">{loudness.truePeakDb.toFixed(1)} dB</div>
                  </div>
                  <div className="rounded border p-2 text-center">
                    <div className="text-xs text-slate-500">LRA</div>
                    <div className="font-medium">{loudness.lra.toFixed(1)} LU</div>
                  </div>
                </div>
              )}
              <label className="block">
                Target LUFS
                <select className="field mt-1" value={targetLufs} onChange={(e) => setTargetLufs(Number(e.target.value))}>
                  <option value={-14}>-14 LUFS (loud, podcast)</option>
                  <option value={-16}>-16 LUFS (speech, recommended)</option>
                  <option value={-23}>-23 LUFS (EBU R128 broadcast)</option>
                  <option value={-24}>-24 LUFS (ATSC broadcast)</option>
                </select>
              </label>
              <label className="block">
                True Peak Limit (dB)
                <input className="field mt-1" type="number" min={-10} max={0} step={0.5} value={truePeakLimit} onChange={(e) => setTruePeakLimit(Number(e.target.value))} />
              </label>
              <button className="btn w-full" onClick={runNormalizeLoudness} disabled={!fileId}>
                Normalize Loudness
              </button>
              <p className="text-xs text-slate-500">
                Two‑pass EBU R128 normalization. Ensures all audio chunks have consistent perceived loudness for training data.
              </p>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">VAD Auto‑Segmentation</h2>
            <div className="space-y-2 text-sm">
              <p className="text-xs text-slate-500">
                Automatically detect speech regions and create ranges. Replaces manual chunking.
              </p>
              <label className="block">
                Silence threshold (dB)
                <input className="field mt-1" type="number" min={-80} max={-10} step={1} value={vadSilenceThreshold} onChange={(e) => setVadSilenceThreshold(Number(e.target.value))} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  Min silence gap (s)
                  <input className="field mt-1" type="number" min={0.1} max={5} step={0.1} value={vadMinSilenceDuration} onChange={(e) => setVadMinSilenceDuration(Number(e.target.value))} />
                </label>
                <label className="block">
                  Min speech length (s)
                  <input className="field mt-1" type="number" min={0.1} max={10} step={0.1} value={vadMinSpeechDuration} onChange={(e) => setVadMinSpeechDuration(Number(e.target.value))} />
                </label>
              </div>
              <button className="btn w-full" onClick={runVadDetection} disabled={!fileId}>
                Detect Speech Regions
              </button>
              <p className="text-xs text-slate-500">
                Detects speech via silence gap inversion. Creates regions for all speech segments. Existing regions are replaced.
              </p>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">Resample Audio</h2>
            <div className="space-y-2 text-sm">
              <p className="text-xs text-slate-500">
                Ensure all audio files share the same sample rate for consistent dataset quality.
                {analysis ? (
                  <span className="ml-1 font-medium text-slate-700">Current: {analysis.sampleRate} Hz</span>
                ) : null}
              </p>
              <label className="block">
                Target Sample Rate (Hz)
                <select
                  className="field mt-1"
                  value={resampleTargetRate}
                  onChange={(e) => setResampleTargetRate(Number(e.target.value))}
                >
                  <option value={8000}>8000 Hz (telephony)</option>
                  <option value={16000}>16000 Hz (speech models)</option>
                  <option value={22050}>22050 Hz (TTS / vocoder)</option>
                  <option value={44100}>44100 Hz (CD quality)</option>
                  <option value={48000}>48000 Hz (studio)</option>
                </select>
              </label>
              <button className="btn w-full" onClick={runResample} disabled={!fileId}>
                Resample to {resampleTargetRate} Hz
              </button>
              <p className="text-xs text-slate-500">
                Converts audio to the selected sample rate (mono, 16-bit PCM). All chunks exported afterward will inherit this rate.
              </p>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel-title">Dataset Export</h2>
            <div className="space-y-2 text-sm">
              <p className="text-xs text-slate-500">
                Export checked regions as individually labeled chunks with a manifest.json for ML training pipelines.
              </p>
              <label className="block">
                Label
                <select className="field mt-1" value={datasetLabel} onChange={(e) => setDatasetLabel(e.target.value as "ai" | "human" | "")}>
                  <option value="human">human</option>
                  <option value="ai">ai</option>
                  <option value="">unlabeled</option>
                </select>
              </label>
              <label className="block">
                Speaker ID
                <input className="field mt-1" type="text" placeholder="e.g. speaker_01" value={datasetSpeakerId} onChange={(e) => setDatasetSpeakerId(e.target.value)} />
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={datasetNormalize} onChange={(e) => setDatasetNormalize(e.target.checked)} />
                Normalize each chunk to target LUFS
              </label>
              {datasetNormalize && (
                <select className="field" value={datasetTargetLufs} onChange={(e) => setDatasetTargetLufs(Number(e.target.value))}>
                  <option value={-14}>-14 LUFS (podcast)</option>
                  <option value={-16}>-16 LUFS (speech)</option>
                  <option value={-23}>-23 LUFS (broadcast)</option>
                </select>
              )}
              <select className="field" value={datasetExportFormat} onChange={(e) => setDatasetExportFormat(e.target.value as ExportFormat)}>
                <option value="wav">.wav</option>
                <option value="mp3">.mp3</option>
              </select>
              <p className="text-xs text-slate-600">
                Checked regions: {selectedExportRegionIds.length} / {regions.length}
              </p>
              <button className="btn w-full" onClick={runDatasetExport} disabled={!fileId || selectedExportRegionIds.length === 0}>
                Export Dataset ({selectedExportRegionIds.length} chunks)
              </button>
              {datasetExports.length > 0 && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs font-medium text-slate-700">Dataset files ({datasetExports.length})</p>
                  <ul className="max-h-48 space-y-1 overflow-auto text-sm">
                    {datasetExports.map((item) => {
                      const filename = item.path.split("/").pop() ?? "file";
                      return (
                        <li key={item.path} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1">
                          <span className="min-w-0 flex-1 truncate text-xs text-slate-700">{item.label}</span>
                          <button
                            type="button"
                            className="shrink-0 rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-xs hover:bg-slate-100"
                            onClick={() => downloadViaBlob(mediaUrl(item.path), filename)}
                          >
                            Download
                          </button>
                          <a className="shrink-0 text-xs text-blue-700 underline" href={mediaUrl(item.path)} target="_blank" rel="noreferrer">Open</a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {datasetManifest && (
                <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2">
                  <p className="mb-1 text-xs font-medium text-slate-700">Manifest Summary</p>
                  <div className="grid grid-cols-2 gap-1 text-xs text-slate-600">
                    <div>Chunks: {datasetManifest.length}</div>
                    <div>Total: {datasetManifest.reduce((a, c) => a + c.durationSec, 0).toFixed(1)}s</div>
                    <div>Label: {datasetManifest[0]?.label || "—"}</div>
                    <div>Speaker: {datasetManifest[0]?.speakerId || "—"}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {busy && <div className="fixed bottom-4 right-4 rounded bg-slate-900 px-3 py-2 text-sm text-white">{busy}</div>}
      {errorModal && (
        <div className="fixed inset-0 grid place-items-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded bg-white p-4 shadow">
            <p>{errorModal}</p>
            <button className="btn mt-3 w-full" onClick={() => setErrorModal(null)}>
              OK
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
