# SONUS — Audio Signal Editor

Production-ready audio editing tool for waveform visualization, non-destructive region editing, and **ML dataset preparation** for AI and human voice classification.

## What is SONUS?

SONUS is a full-stack web application designed for:

- **Audio cleanup** — noise reduction, silence trimming, EQ filtering, loudness normalization
- **Dataset creation** — chunking long audio into labeled segments for ML training
- **AI vs Human voice dataset preparation** — label, normalize, and export structured datasets with manifest metadata
- **Batch processing** — analyze, clean, and export hundreds of files in one workflow

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 · Vite · TypeScript · TailwindCSS 4 · Zustand · WaveSurfer.js |
| Backend | Node.js · Express 5 · TypeScript |
| Audio engine | FFmpeg (bundled via `ffmpeg-static`, no global install needed) |
| Storage | Local filesystem (`backend/storage/`) |

---

## Features

### Core Audio Editing
- Upload `.mp3`, `.wav`, `.amr`, `.m4a`, `.aac`, `.ogg`, `.webm` (up to 50MB)
- Internal standardization to WAV (16kHz, mono)
- Interactive waveform with play/pause, seek, zoom, and timeline
- Spectrogram view for noise/hum/artifact inspection
- 1D signal oscilloscope visualization
- Playback speed control (0.5x–4x)
- Keyboard shortcut: `Space` to play/pause

### Region Editing
- Add, remove, drag, resize regions on the waveform
- Draw regions directly on waveform (toggle mode)
- Editable start/end time inputs per region
- Overlap prevention with validation
- Crop to selected regions or remove selected regions
- Undo/redo for all region and filter changes (50-level history)

### Filters (FFmpeg-backed)
- High-pass / low-pass frequency filter
- Echo cancellation (`aecho`)
- Noise reduction (`afftdn`)
- Silence trimming (`silenceremove`)

### Audio Analysis
- Duration, sample rate, channels, bitrate
- Mean/max volume and clipping risk assessment
- Silence segment detection and total silence duration
- One-click recommended cleanup settings

### LUFS Loudness Normalization
- Measure current loudness (integrated LUFS, true peak, LRA)
- Two-pass EBU R128 normalization
- Presets: -14 LUFS (podcast), -16 LUFS (speech), -23 LUFS (broadcast), -24 LUFS (ATSC)
- Per-chunk normalization during dataset export

### VAD Auto-Segmentation
- One-click voice activity detection
- Automatically creates regions for all speech segments
- Configurable silence threshold, minimum gap, and minimum segment length
- Replaces hours of manual chunking

### Export
- Full audio, selected regions (concatenated), or split chunks
- Formats: `.wav`, `.mp3`
- Auto-download with fallback download list

### Dataset Export
- Export checked regions as individually labeled chunks
- Labels: `human`, `ai`, or `unlabeled`
- Custom speaker ID per export
- Optional per-chunk LUFS normalization
- Generates `manifest.json` with full metadata per chunk
- Compatible with standard ML dataset pipelines

### Batch Processing
- Multi-file upload queue
- Analyze all, auto-clean all, export all
- Per-file status tracking and download links

### Session Management
- Persistent editor state across browser refreshes
- Validates saved state on reload (clears if backend files expired)
- Clear session button to reset everything
- A/B comparison between original and processed audio

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | Windows 10+, macOS, Linux | Any modern OS |
| Node.js | 20.x | Latest LTS |
| npm | 10.x | Latest |
| RAM | 8 GB | 16 GB (for large batches) |
| Disk | 2 GB free | 10+ GB for large datasets |
| Browser | Chrome, Edge, Firefox | Latest Chrome/Edge |
| Internet | For initial `npm install` | — |

> **No global FFmpeg install is needed.** The backend uses bundled binaries via `ffmpeg-static` and `ffprobe-static`.

---

## Quick Start

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd SONUS
```

### 2. Start the backend

```bash
cd backend
npm install
npm run generate:sample
npm run dev
```

Backend runs on **http://localhost:4000**

### 3. Start the frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on **http://localhost:5173**

### 4. Open the app

Navigate to **http://localhost:5173** in your browser. Upload an audio file to begin.

---

## Project Structure

```
SONUS/
├── frontend/                  # React + Vite app
│   ├── src/
│   │   ├── App.tsx            # Main application component (all UI)
│   │   ├── api.ts             # API client functions
│   │   ├── types.ts           # TypeScript type definitions
│   │   ├── main.tsx           # Entry point
│   │   ├── index.css          # Tailwind + utility classes
│   │   ├── store/
│   │   │   └── editorStore.ts # Zustand state management (undo/redo)
│   │   └── lib/
│   │       ├── regions.ts     # Region validation utilities
│   │       └── persistUi.ts   # LocalStorage persistence
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
│
├── backend/                   # Express + FFmpeg API server
│   ├── src/
│   │   ├── index.ts           # Express server, routes, file cleanup
│   │   └── ffmpegService.ts   # All FFmpeg operations
│   ├── storage/               # Runtime file storage (auto-created)
│   │   ├── uploads/           # Raw uploaded files
│   │   ├── processed/         # Standardized/processed WAVs
│   │   └── exports/           # Exported chunks and datasets
│   ├── samples/               # Generated sample audio
│   ├── scripts/
│   │   └── generate-sample.mjs
│   └── package.json
│
├── README.md                  # This file
├── REQUIREMENTS.md            # Dependency checklist
└── USER_MANUAL.md             # Detailed usage guide
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/upload` | Upload and standardize audio file |
| `POST` | `/process` | Apply filters to current file |
| `POST` | `/analyze` | Analyze audio quality and artifacts |
| `POST` | `/export` | Export full/selected/chunks |
| `POST` | `/normalize` | LUFS loudness normalization |
| `POST` | `/measure-loudness` | Measure current LUFS/peak/LRA |
| `POST` | `/detect-regions` | VAD auto-segmentation |
| `POST` | `/export-dataset` | Export chunks + manifest.json |
| `POST` | `/remove-ranges` | Remove time ranges from audio |
| `POST` | `/keep-ranges` | Keep only selected ranges |
| `GET` | `/media/**` | Serve processed/exported files |
| `GET` | `/samples/**` | Serve sample files |
| `GET` | `/health` | Health check |

---

## Notes

- All audio processing uses real FFmpeg commands — no browser-side processing
- Files in `backend/storage/` are automatically cleaned up after 1 hour
- Session state is saved to `localStorage` and validated on reload
- Undo/redo history is capped at 50 entries to limit memory usage
- The download system uses `fetch` → blob → object URL to handle cross-origin downloads between the dev servers
