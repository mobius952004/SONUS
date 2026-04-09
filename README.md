# Audio Signal Editor

Production-ready full-stack audio editing app focused on waveform visualization and non-destructive region editing.

## Stack

- Frontend: React + Vite + TypeScript + TailwindCSS + Zustand + WaveSurfer.js (regions + timeline)
- Backend: Node.js + Express + TypeScript
- Audio engine: FFmpeg (via `ffmpeg-static`)
- Storage: local filesystem (`backend/storage`)

## Features

- Upload and validate `.mp3`, `.wav`, `.amr`, `.m4a`, `.aac`, `.ogg`, `.webm` up to 50MB
- Internal standardization to WAV (`16kHz`, mono)
- Interactive waveform:
  - Play/pause
  - Seek
  - Zoom
  - Time axis
- Multiple editable ranges (regions)
  - Add/remove
  - Drag/resize
  - Editable start/end inputs
  - Overlap prevention with modal alert and revert
- Undo/redo for region and filter state changes
- Playback speed control (`0.5x` to `4x`)
- Filters (FFmpeg-backed):
  - High-pass / low-pass
  - Echo (`aecho`)
  - Noise reduction (`afftdn`)
  - Silence trimming (`silenceremove`)
- Audio analyzer:
  - Duration, sample rate, channels, bitrate
  - Mean/max volume and clipping risk
  - Silence segment detection
  - One-click recommended cleanup settings
- Export:
  - Full audio
  - Selected regions (concatenated)
  - Split chunks
  - Formats: `.wav`, `.mp3`
- Batch dataset workflow:
  - Multi-file upload queue
  - Analyze all files
  - Auto-clean all files using analyzer recommendations
  - Export all files in selected format

## Project Structure

```txt
frontend/   # React app
backend/    # Express + FFmpeg APIs
```

## Setup

## Quick Start (2 minutes)

```bash
# Terminal 1
cd backend
npm install
npm run generate:sample
npm run dev

# Terminal 2
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, upload an audio file, then use **Analyze Audio** -> **Apply Recommended Cleanup Settings** -> **Apply Filters** -> **Export Audio**.

## System Requirements

- OS: Windows, macOS, or Linux
- Node.js: `>=20.x` (LTS recommended)
- npm: `>=10.x`
- RAM: 8GB minimum (16GB recommended for large batch processing)
- Disk: 2GB free minimum, more for large datasets and exports
- Internet: required for initial `npm install`

Full dependency and environment checklist is available in `REQUIREMENTS.md`.

### 1) Backend

```bash
cd backend
npm install
npm run generate:sample
npm run dev
```

Backend runs on `http://localhost:4000`.

### 2) Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

## What the current app does

This version is built for practical audio cleanup and dataset preparation:

- Processes one audio file interactively with waveform, regions, filters, and export controls.
- Supports A/B listening between original and processed output.
- Analyzes uploaded audio and surfaces artifact indicators (noise level, clipping risk, silence profile).
- Applies recommended cleanup settings automatically from analyzer output.
- Runs a batch queue to analyze, auto-clean, and export multiple files in one flow.
- Exports either full audio, selected region combinations, or selected regions split as chunks.

## How to use

### Single-file workflow

1. Upload an audio file in the top-left upload control.
2. Use the waveform to play, seek, zoom, and set playback speed.
3. Create ranges with **Add Range**, adjust start/end in **Range Editor**, and mark which ranges to include for export.
4. In **Filters**, configure cleanup options (high/low pass, noise reduction, silence trimming, etc.) and click **Apply Filters**.
5. In **Audio Analyzer**, click **Analyze Audio** to inspect characteristics and optionally click **Apply Recommended Cleanup Settings**.
6. In **Processed Output Preview**, listen to generated processed versions.
7. In **A/B Compare**, compare original vs latest processed output.
8. In **Export**, choose mode (`full`, `selected`, or `chunks`) and format (`.wav` / `.mp3`), then click **Export Audio**.

### Batch dataset workflow

1. In **Batch Dataset Pipeline**, select multiple files using the multi-file input.
2. Click **Analyze All** to compute artifact and quality metrics for each file.
3. Click **Auto-Clean All** to process each file using analyzer-based recommended settings.
4. Select batch export format and click **Export All**.
5. Download each result from the per-file export links in the batch list.

### Selecting and exporting multiple chunks from one file

1. Add multiple ranges in the main editor.
2. In **Range Editor**, check **Include this range in selected/chunk export** for each range you want.
3. In **Export**, choose:
   - `Selected regions only` to concatenate checked ranges into one file, or
   - `Split into chunks` to export each checked range as a separate chunk file.
4. Click **Export Audio** and download from generated links.

## API Endpoints

- `POST /upload` - upload and standardize audio
- `POST /process` - apply filters on current standardized file
- `POST /analyze` - inspect audio quality/artifacts and recommendations
- `POST /export` - export full/selected/chunks in requested format
- `GET /media/**` - serve generated media files
- `GET /samples/**` - serve sample files

## Notes

- Processing uses real FFmpeg commands end-to-end.
- Exported files are written locally under `backend/storage/exports`.
- Sample file generation uses FFmpeg and writes to `backend/samples/sample-voice.wav`.
- For reproducible setup and dependency details, see `REQUIREMENTS.md`.
