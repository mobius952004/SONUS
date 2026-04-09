import type { Region } from "../types";

export const isValidRange = (start: number, end: number) => start >= 0 && end > start;

export const hasOverlap = (regions: Region[]) => {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) return true;
  }
  return false;
};

export const withUpdatedRegion = (regions: Region[], updated: Region): Region[] =>
  regions.map((region) => (region.id === updated.id ? updated : region));

export const nextRegionWindow = (regions: Region[], duration: number) => {
  const ordered = [...regions].sort((a, b) => a.start - b.start);
  const width = Math.min(3, Math.max(0.5, duration / 8));
  let cursor = 0;
  for (const region of ordered) {
    if (cursor + width <= region.start) {
      return { start: cursor, end: cursor + width };
    }
    cursor = Math.max(cursor, region.end);
  }
  const end = Math.min(duration, cursor + width);
  const start = Math.max(0, end - width);
  return { start, end };
};
