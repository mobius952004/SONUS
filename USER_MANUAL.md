# SONUS User Manual

A comprehensive guide to using SONUS for audio processing and ML dataset creation.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Interface Overview](#2-interface-overview)
3. [Uploading Audio](#3-uploading-audio)
4. [Waveform Controls](#4-waveform-controls)
5. [Working with Regions](#5-working-with-regions)
6. [Applying Filters](#6-applying-filters)
7. [Audio Analysis](#7-audio-analysis)
8. [LUFS Loudness Normalization](#8-lufs-loudness-normalization)
9. [VAD Auto-Segmentation](#9-vad-auto-segmentation)
10. [Standard Export](#10-standard-export)
11. [Dataset Export with Manifest](#11-dataset-export-with-manifest)
12. [Batch Processing](#12-batch-processing)
13. [A/B Comparison](#13-ab-comparison)
14. [Session Management](#14-session-management)
15. [Keyboard Shortcuts](#15-keyboard-shortcuts)
16. [Workflow Recipes](#16-workflow-recipes)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Getting Started

### Prerequisites

Before running SONUS, make sure you have:

- **Node.js 20+** — Download from [nodejs.org](https://nodejs.org)
- **npm 10+** — Comes with Node.js
- **A modern browser** — Chrome, Edge, or Firefox (latest version)

Verify your installation:

```bash
node --version    # Should show v20.x.x or higher
npm --version     # Should show 10.x.x or higher
```

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd SONUS

# Install and start the backend
cd backend
npm install
npm run generate:sample    # Creates a sample audio file for testing
npm run dev                # Starts on http://localhost:4000

# Open a new terminal window
cd frontend
npm install
npm run dev                # Starts on http://localhost:5173
```

### First Launch

1. Open **http://localhost:5173** in your browser
2. You'll see the Audio Signal Editor with an empty waveform area
3. Upload an audio file to begin editing

> **Tip:** Both terminals must stay running while you use the app. The frontend talks to the backend for all audio processing.

---

## 2. Interface Overview

The interface is divided into two main areas:

### Left Side — Editor Area
- **File upload** and playback controls
- **Waveform** display with interactive regions
- **Spectrogram** toggle for frequency analysis
- **1D Signal oscilloscope** visualization
- **Zoom** and **playback speed** sliders

### Right Side — Tool Panels
Scrollable sidebar containing all tool panels:

| Panel | Purpose |
|-------|---------|
| Range Editor | Manage regions, select for export |
| Filters | Audio cleanup: EQ, noise reduction, silence trimming |
| Audio Analyzer | Quality inspection and auto-recommendations |
| Processed Output Preview | Listen to previous processing results |
| A/B Compare | Side-by-side original vs processed playback |
| Export | Standard audio export (full/selected/chunks) |
| Batch Dataset Pipeline | Multi-file upload and batch processing |
| LUFS Loudness Normalization | Measure and normalize loudness |
| VAD Auto‑Segmentation | Automatic speech region detection |
| Dataset Export | ML-ready export with manifest.json |

---

## 3. Uploading Audio

### Supported Formats
`.mp3`, `.wav`, `.amr`, `.m4a`, `.aac`, `.ogg`, `.webm`

### Size Limit
Maximum **50 MB** per file.

### How to Upload
1. Click **Choose File** in the top-left corner
2. Select your audio file
3. The app will:
   - Upload the file to the backend
   - Convert it to standardized WAV (16 kHz, mono)
   - Load the waveform display

> **Note:** The conversion to 16 kHz mono WAV happens automatically. This is the working format used internally. You can export in different formats later.

---

## 4. Waveform Controls

### Playback
- Click the **▶ Play** button or press **Space** to play/pause
- Click anywhere on the waveform to **seek** to that position
- The red cursor line shows the current playback position

### Zoom
- Use the **Zoom** slider below the waveform (range: 1–200)
- Higher values zoom in for precise editing
- Lower values show the full audio overview

### Playback Speed
- Use the **Playback speed** slider (range: 0.5x–4x)
- Useful for reviewing long recordings quickly or inspecting details slowly

### Spectrogram
- Click **Show Spectrogram** to toggle the frequency visualization
- Useful for visually identifying noise, hum (horizontal bands), or artifacts
- The spectrogram appears below the waveform

### Waveform Draw Mode
- Click **Draw range on waveform** to enable drag-to-create region mode
- Click and drag on the waveform to create a new region
- Click the button again to disable draw mode (prevents accidental region creation)

---

## 5. Working with Regions

Regions (ranges) are highlighted sections of the waveform. They define which parts of the audio to export, keep, or remove.

### Creating Regions

**Method 1 — Button:**
Click **Add Range** to create a region at the next available gap.

**Method 2 — Drawing:**
1. Click **Draw range on waveform** to enter draw mode
2. Click and drag on the waveform to create a region
3. The region is created and automatically selected

### Editing Regions
- **Drag** a region to move it horizontally
- **Drag the edges** to resize
- In the **Range Editor** panel, edit the **start** and **end** times numerically
- Overlapping regions are **not allowed** — the editor will revert invalid changes

### Selecting Regions
- **Click** a region on the waveform to select it (darker highlight)
- The selected region's details appear in the Range Editor
- Click **Play selected region** to preview just that region

### Checking Regions for Export
In the **Range Editor** panel, each region has a checkbox:
- ☑ **Checked** — included in export/crop/remove operations
- ☐ **Unchecked** — excluded from operations

Use **Select All for Export** or **Select None** buttons for bulk selection.

### Removing Regions
1. Click a region to select it
2. Click **Remove Range** to delete the selected region

### Crop / Remove Operations
- **Remove checked ranges** — Deletes the audio in checked regions, keeps everything else
- **Crop to checked ranges** — Keeps only the checked regions, removes everything else

> **Warning:** Crop and Remove modify the working audio file. Use **Undo** if needed.

---

## 6. Applying Filters

The **Filters** panel provides audio cleanup tools. All filters are applied via FFmpeg on the backend.

### Pass Filter (EQ)
- **None** — No frequency filtering
- **Highpass** — Removes frequencies below the threshold (removes rumble/bass noise)
- **Lowpass** — Removes frequencies above the threshold (removes hiss/high noise)
- Set the **Frequency (Hz)** cutoff (default: 1000 Hz)
- For speech cleanup, a highpass at 80–120 Hz is common

### Echo Cancellation
- Toggle **Echo cancellation / echo filter**
- **Delay (ms)** — Echo delay in milliseconds
- **Decay** — How fast the echo fades (0 = no echo, 1 = infinite echo)

### Noise Reduction
- Toggle **Noise reduction (afftdn)**
- **Noise floor (dB)** — Lower values = more aggressive noise removal
- Typical values: -20 (aggressive), -30 (moderate), -40 (light)

### Silence Trimming
- Toggle **Trim silence/artifacts**
- **Threshold (dB)** — Audio below this level is considered silence
- **Min duration (s)** — Minimum silence duration to trigger removal

### Applying
Click **Apply Filters** to process. The waveform updates to show the processed audio.

> **Tip:** Use the Audio Analyzer first to get recommended cleanup settings, then fine-tune.

---

## 7. Audio Analysis

Click **Analyze Audio** in the **Audio Analyzer** panel to scan your file. The analyzer reports:

| Metric | What it tells you |
|--------|------------------|
| Duration | Total length in seconds |
| Sample Rate | Audio sampling rate (Hz) |
| Channels | Mono/stereo |
| Bitrate | Audio quality (kbps) |
| Mean Volume | Average loudness (dB) |
| Max Volume | Peak loudness (dB) — values near 0 = clipping risk |
| Silence Segments | Number of detected silence gaps |
| Total Silence | Cumulative silent time |
| Noise Level | Estimated noise: low / medium / high |
| Clipping Risk | Estimated clipping: low / medium / high |

### Auto-Cleanup
After analysis, click **Apply Recommended Cleanup Settings** to automatically configure the Filters panel based on the analysis result. Then click **Apply Filters** to execute.

---

## 8. LUFS Loudness Normalization

LUFS (Loudness Units relative to Full Scale) is the broadcast-standard measurement for perceived loudness. **Consistent loudness is critical for ML datasets** — variable volume across samples degrades model performance.

### Measuring

1. Load or process your audio file
2. In the **LUFS Loudness Normalization** panel, click **Measure Current Loudness**
3. You'll see three metrics:
   - **Integrated LUFS** — Overall perceived loudness
   - **True Peak (dB)** — Maximum signal peak
   - **LRA (LU)** — Loudness range (dynamic range)

### Normalizing

1. Select a **Target LUFS** from the dropdown:
   - **-14 LUFS** — Loud, suitable for podcasts
   - **-16 LUFS** — Standard for speech (recommended for datasets)
   - **-23 LUFS** — EBU R128 broadcast standard
   - **-24 LUFS** — ATSC broadcast standard
2. Set **True Peak Limit** (default: -1.0 dB, prevents clipping)
3. Click **Normalize Loudness**
4. The waveform updates with the normalized audio

> **How it works:** SONUS uses a two-pass process. First pass measures the exact loudness profile, second pass applies precise correction. This is the same technique used in broadcast mastering.

---

## 9. VAD Auto-Segmentation

Voice Activity Detection (VAD) automatically identifies speech segments in your audio. Instead of manually creating regions for each spoken phrase, VAD does it in seconds.

### Parameters

| Parameter | Default | What it controls |
|-----------|---------|-----------------|
| Silence threshold (dB) | -35 | Below this level = silence. Lower values detect quieter speech |
| Min silence gap (s) | 0.4 | Gaps shorter than this are treated as pauses within speech (not boundaries) |
| Min speech length (s) | 0.3 | Speech segments shorter than this are discarded |

### Using VAD

1. Upload and optionally process your audio first
2. In the **VAD Auto-Segmentation** panel:
   - Adjust parameters if needed (defaults work well for most speech)
   - Click **Detect Speech Regions**
3. The editor replaces all existing regions with detected speech segments
4. All detected regions are pre-checked for export
5. Review the regions on the waveform — adjust or remove any you don't want

### Tips for Best Results

- **Noisy audio?** Lower the silence threshold to -45 or -50 dB
- **Cutting off words?** Reduce the min silence gap to 0.2s
- **Too many tiny segments?** Increase min speech length to 0.5s or 1.0s
- **Run filters first** (noise reduction) before VAD for cleaner detection

---

## 10. Standard Export

The **Export** panel offers three modes:

### Full Edited Audio
Exports the entire current audio file as one file.

### Selected Regions Only
Concatenates all **checked** regions into one continuous file (gaps between regions are removed).

### Split into Chunks
Exports each checked region as a separate file. Two sub-modes:

- **Selected ranges** — Each checked region becomes one chunk
- **Fixed duration** — Splits the entire file into equal-length chunks (e.g., every 30 seconds)

### Export Settings
- **Format:** `.wav` or `.mp3`
- **Auto-download:** Automatically downloads the first exported file
- **Open preview:** Opens single-file exports in a new browser tab

### Downloading
After export, a list of exported files appears below the Export button. Each file has:
- **Download** button — Downloads the file to your computer
- **Open** link — Opens the file in a new browser tab

---

## 11. Dataset Export with Manifest

The **Dataset Export** is specifically designed for creating ML training datasets. Unlike standard Export, it produces labeled, individually normalized chunks with a structured `manifest.json`.

### Configuration

1. **Label** — Choose `human`, `ai`, or `unlabeled`
2. **Speaker ID** — Optional identifier (e.g., `speaker_01`, `narrator_a`)
3. **Normalize each chunk** — Toggle per-chunk LUFS normalization
   - Select target LUFS when enabled (-14, -16, or -23)
4. **Format** — `.wav` or `.mp3`

### Exporting

1. Make sure regions are created and **checked** (use VAD or add manually)
2. The panel shows "Checked regions: X / Y" as confirmation
3. Click **Export Dataset (X chunks)**
4. After processing, you'll see:
   - A **file list** with Download/Open buttons for each chunk + manifest
   - A **Manifest Summary** showing total chunks, duration, label, and speaker

### What Gets Exported

For each checked region, a separate audio file is created:
```
<export-id>-chunk-1.wav
<export-id>-chunk-2.wav
<export-id>-chunk-3.wav
...
manifest.json
```

### manifest.json Structure

```json
{
  "exportedAt": "2026-04-14T17:20:00.000Z",
  "totalChunks": 3,
  "totalDurationSec": 24.5,
  "label": "human",
  "speakerId": "speaker_01",
  "normalizedLufs": -16,
  "chunks": [
    {
      "filename": "abc-chunk-1.wav",
      "index": 1,
      "startSec": 0.5,
      "endSec": 8.2,
      "durationSec": 7.7,
      "sampleRate": 16000,
      "channels": 1,
      "format": "wav",
      "label": "human",
      "speakerId": "speaker_01"
    },
    {
      "filename": "abc-chunk-2.wav",
      "index": 2,
      "startSec": 12.1,
      "endSec": 20.3,
      "durationSec": 8.2,
      "sampleRate": 16000,
      "channels": 1,
      "format": "wav",
      "label": "human",
      "speakerId": "speaker_01"
    }
  ]
}
```

---

## 12. Batch Processing

The **Batch Dataset Pipeline** processes multiple files in sequence.

### Steps

1. Click the file input and select **multiple audio files**
2. Files appear in the batch list with status `uploaded`
3. **Analyze All** — Runs audio analysis on every file
4. **Auto-Clean All** — Applies recommended cleanup to every file based on analysis
5. Select export format (`.wav` / `.mp3`)
6. **Export All** — Exports each processed file
7. Download each result from the per-file links

> **Note:** Each new batch upload **appends** to the existing list. Use **Clear session** to reset everything.

---

## 13. A/B Comparison

Compare the original upload vs the latest processed version:

1. In **A/B Compare**, you'll see two audio players:
   - **Original** — Your raw upload
   - **Processed** — Latest filtered/normalized version
2. Click **Sync & Play Both** to start playback from the same position
3. Click **Pause Both** to stop
4. Listen for differences in noise, clarity, and loudness

---

## 14. Session Management

### Auto-Save
Your editor state is automatically saved to the browser's `localStorage` every 500ms. This includes:
- Current file reference
- All regions
- Filter settings
- Playback speed
- Export settings
- Zoom level

### Resuming
When you reload the page, SONUS checks if the saved file still exists on the server. If yes, your session is restored. If the file was cleaned up (after 1 hour), the session is cleared.

### Clearing
Click **Clear session** to reset everything:
- All regions and filters
- Processed previews
- Export history
- Batch items
- LocalStorage data

---

## 15. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause (when not focused on a text input) |
| `Ctrl+Z` | Undo (via Undo button) |
| `Ctrl+Y` | Redo (via Redo button) |

---

## 16. Workflow Recipes

### Recipe 1: Quick Dataset from a Long AI Recording

```
1. Upload → long_ai_recording.mp3
2. Audio Analyzer → Analyze Audio → Apply Recommended Cleanup
3. Filters → Apply Filters
4. LUFS Normalization → Measure → Normalize to -16 LUFS
5. VAD Auto-Segmentation → Detect Speech Regions
6. Review regions on waveform (delete any unwanted ones)
7. Dataset Export:
   - Label: "ai"
   - Speaker ID: "tts_model_v2"
   - Normalize: ✅ -16 LUFS
   - Format: .wav
8. Click Export Dataset → Download all chunks + manifest.json
```

### Recipe 2: Human Voice Dataset from Interview

```
1. Upload → interview_raw.wav
2. Filters:
   - Highpass: 90 Hz (remove room rumble)
   - Noise reduction: -25 dB
   - Silence trimming: threshold -40 dB, min 0.3s
3. Apply Filters
4. LUFS → Normalize to -16 LUFS
5. VAD → Detect Speech Regions
   - Min silence gap: 0.6s (longer pauses between questions)
   - Min speech length: 1.0s (skip short "uh-huh"s)
6. In Range Editor, uncheck any interviewer segments
7. Dataset Export:
   - Label: "human"
   - Speaker ID: "subject_001"
   - Export → Download
```

### Recipe 3: Batch Process 50 Files

```
1. Batch Dataset Pipeline → Select 50 files
2. Analyze All (wait for completion)
3. Auto-Clean All (applies per-file recommended settings)
4. Export All as .wav
5. Download each from the batch list
```

### Recipe 4: A/B Quality Check

```
1. Upload audio file
2. Analyze and note the noise level / clipping risk
3. Apply cleanup filters
4. Go to A/B Compare → Sync & Play Both
5. Listen for improvements
6. If satisfied, export. If not, Undo and adjust filters.
```

---

## 17. Troubleshooting

### "Failed to load audio waveform"
- Check that the backend is running on port 4000
- Check the terminal for FFmpeg errors
- Try re-uploading the file

### Export downloads navigate away from the page
- This was a known bug (fixed). Make sure you're running the latest code.
- If it still happens, use the **Open** link instead of Download

### VAD detects no speech regions
- Lower the silence threshold (e.g., from -35 to -50 dB)
- Reduce minimum speech length
- Make sure your audio actually contains speech (not just music/noise)
- Try running noise reduction first, then re-run VAD

### Session shows old/missing file on reload
- The backend cleans up files older than 1 hour
- Click **Clear session** and re-upload your file

### Backend won't start
- Make sure Node.js 20+ is installed
- Run `npm install` in the `backend/` directory
- Check that port 4000 isn't already in use

### Frontend shows blank page
- Make sure the backend is running first
- Run `npm install` in the `frontend/` directory
- Clear browser cache and reload

### Processing is slow
- Large files (>30MB) take longer for FFmpeg operations
- LUFS normalization involves two passes (measure + process)
- Dataset export with normalization processes each chunk twice
- Batch operations run sequentially per file

---

## File Lifecycle

```
Upload                    Processing                  Export
───────                   ──────────                  ──────
User uploads .mp3    →    Converts to .wav (16kHz)    
                          Stored in storage/processed/
                     
Apply Filters        →    New .wav in storage/processed/
Normalize            →    New .wav in storage/processed/
                     
Export/Dataset       →    Chunks in storage/exports/<id>/
                          manifest.json in same directory

                     ⏰ Auto-cleanup: files older than 1 hour
                          are deleted every 15 minutes
```

> **Important:** Exported files are temporary. Download them promptly. The server cleans up files older than 1 hour.
