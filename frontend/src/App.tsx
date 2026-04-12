import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import { analyzeAudio, exportAudio, mediaUrl, processAudio, removeRangesFromAudio, uploadAudio } from "./api";
import { hasOverlap, isValidRange, nextRegionWindow, withUpdatedRegion } from "./lib/regions";
import { useEditorStore } from "./store/editorStore";
import type { AudioAnalysis, ExportFormat, ExportMode, Region } from "./types";

const ACCEPT_TYPES = ".mp3,.wav,.amr,.m4a,.aac,.ogg,.webm";
const MAX_FILE_SIZE = 50 * 1024 * 1024;
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
  const lastUiTickRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showSpectrogram, setShowSpectrogram] = useState(false);
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
  const originalAudioRef = useRef<HTMLAudioElement | null>(null);
  const processedAudioRef = useRef<HTMLAudioElement | null>(null);

  const {
    fileId,
    sourceUrl,
    selectedRegionId,
    playbackRate,
    regions,
    filters,
    setAudioFile,
    setSelectedRegion,
    setPlaybackRate,
    commitRegions,
    commitFilters,
    undo,
    redo,
  } = useEditorStore();

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
    if (!waveformRef.current || !timelineRef.current || !spectrogramRef.current || waveSurferRef.current) return;
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
      plugins: [
        regionsPlugin,
        TimelinePlugin.create({ container: timelineRef.current }),
        SpectrogramPlugin.create({
          container: spectrogramRef.current,
          labels: true,
          splitChannels: false,
          scale: "mel",
        }),
      ],
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
      ws.destroy();
    };
  }, [commitRegions, setSelectedRegion]);

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

  useEffect(() => {
    setSelectedExportRegionIds((prev) => {
      const valid = prev.filter((id) => regions.some((r) => r.id === id));
      const missing = regions.filter((r) => !valid.includes(r.id)).map((r) => r.id);
      return [...valid, ...missing];
    });
  }, [regions]);

  const onUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setErrorModal("Max file size is 50MB.");
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
    } catch (error) {
      setErrorModal((error as Error).message || "Upload failed. Check backend connection.");
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
      setAudioFile(result.fileId, mediaUrl(result.path));
      setExports([]);
      setProcessedPreviews((prev) => [{ fileId: result.fileId, path: result.path, createdAt: Date.now() }, ...prev]);
      setWavePreviewMode("current");
    } catch (error) {
      setErrorModal((error as Error).message || "Filter processing failed.");
    } finally {
      setBusy(null);
    }
  };

  const cutSelectedRangeFromAudio = async () => {
    if (!fileId || !selectedRegion) return;
    setBusy("Removing selected range from audio...");
    try {
      const result = await removeRangesFromAudio(fileId, [selectedRegion]);
      setAudioFile(result.fileId, mediaUrl(result.path));
      setExports([]);
      setProcessedPreviews((prev) => [{ fileId: result.fileId, path: result.path, createdAt: Date.now() }, ...prev]);
      setWavePreviewMode("current");
      setAnalysis(null);
    } catch (error) {
      setErrorModal((error as Error).message || "Could not remove range from audio.");
    } finally {
      setBusy(null);
    }
  };

  const runExport = async () => {
    if (!fileId) return;
    const previewWindow = openPreviewOnExport ? window.open("about:blank", "_blank") : null;
    setBusy("Exporting...");
    try {
      const chosenRegions =
        exportMode === "full" ? [] : regions.filter((region) => selectedExportRegionIds.includes(region.id));
      const useFixedDuration = exportMode === "chunks" && chunkSplitMode === "fixedDuration";
      const result = await exportAudio(
        fileId,
        useFixedDuration ? [] : chosenRegions,
        exportMode,
        exportFormat,
        useFixedDuration ? fixedChunkDurationSec : undefined,
      );
      setExports(result.files);

      if (result.files.length > 0 && previewWindow) {
        previewWindow.location.href = mediaUrl(result.files[0].path);
      } else if (previewWindow) {
        previewWindow.close();
      }

      if (autoDownloadOnExport) {
        result.files.forEach((file, index) => {
          const link = document.createElement("a");
          link.href = mediaUrl(file.path);
          link.download = file.path.split("/").pop() ?? `export-${index + 1}.${exportFormat}`;
          link.rel = "noopener";
          document.body.appendChild(link);
          window.setTimeout(() => {
            link.click();
            link.remove();
          }, index * 120);
        });
      }
    } catch (error) {
      if (previewWindow) previewWindow.close();
      setErrorModal((error as Error).message || "Export failed.");
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
      setErrorModal((error as Error).message || "Analysis failed.");
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
          error: "File too large (>50MB).",
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
          error: (error as Error).message,
        });
      }
    }
    setBatchItems(nextItems);
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
        updated.push({ ...item, status: "error", error: (error as Error).message });
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
          ...filters,
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
        updated.push({ ...item, status: "error", error: (error as Error).message });
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
        updated.push({ ...item, status: "error", error: (error as Error).message });
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && (event.target as HTMLElement)?.tagName !== "INPUT") {
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
            <input type="file" accept={ACCEPT_TYPES} onChange={onUpload} className="rounded border p-2 text-sm" />
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
            <button className="btn" onClick={removeRegion} disabled={!selectedRegionId}>
              Remove Range
            </button>
            <button
              className="btn !border-rose-200 !bg-rose-50 !text-rose-900 hover:!bg-rose-100"
              onClick={cutSelectedRangeFromAudio}
              disabled={!fileId || !selectedRegion}
              title="FFmpeg removes the highlighted time range and loads the shorter clip as the new current file."
            >
              Cut selection from audio
            </button>
            <button className="btn" onClick={undo}>
              Undo
            </button>
            <button className="btn" onClick={redo}>
              Redo
            </button>
          </div>

          <div className="mt-4 rounded border bg-slate-50 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
              <span>
                {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
              </span>
              <span>Press Space to play/pause</span>
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
            <div ref={spectrogramRef} className={`mt-2 overflow-x-auto rounded border ${showSpectrogram ? "block" : "hidden"}`} />
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
            <div className="space-y-2">
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
                    Include this range in selected/chunk export
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
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={openPreviewOnExport} onChange={(e) => setOpenPreviewOnExport(e.target.checked)} />
                Open exported audio preview in new tab
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
              <ul className="mt-3 space-y-1 text-sm">
                {exports.map((item) => (
                  <li key={item.path}>
                    <a className="text-blue-700 underline" href={mediaUrl(item.path)} target="_blank" rel="noreferrer">
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
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
