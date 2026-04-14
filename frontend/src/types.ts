export type Region = {
  id: string;
  start: number;
  end: number;
};

export type FilterConfig = {
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

export type ExportMode = "full" | "selected" | "chunks";
export type ExportFormat = "wav" | "mp3";

export type AudioAnalysis = {
  durationSec: number;
  sampleRate: number;
  channels: number;
  bitRateKbps: number;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  silenceSegments: number;
  silenceTotalSec: number;
  estimatedNoiseLevel: "low" | "medium" | "high";
  clippingRisk: "low" | "medium" | "high";
  recommended: {
    noiseEnabled: boolean;
    noiseFloor: number;
    passType: "none" | "highpass";
    passFrequency: number;
    trimSilenceEnabled: boolean;
    trimSilenceThreshold: number;
    trimSilenceMinDuration: number;
  };
};

export type LoudnessMeasurement = {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
};

export type DetectedRegion = {
  start: number;
  end: number;
  durationSec: number;
};

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
