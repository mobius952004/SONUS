# Requirements Checklist

This file lists everything required to run the current version of the Audio Signal Editor locally.

## 1) System Requirements

- OS: Windows 10/11, macOS, or Linux
- CPU: 2+ cores recommended
- RAM: 8GB minimum, 16GB recommended for batch jobs
- Disk space: at least 2GB free (more for large audio datasets)
- Network: internet access for initial dependency install

## 2) Runtime and Tooling

- Node.js: `>=20.x` (LTS recommended)
- npm: `>=10.x`
- Shell access (PowerShell/Bash/Zsh) to run scripts

## 3) Audio Tooling

No global FFmpeg install is required.

The backend uses bundled binaries via npm packages:

- `ffmpeg-static`
- `ffprobe-static`

## 4) Backend Dependencies (Node + Express)

Installed in `backend/` via `npm install`:

- Runtime dependencies:
  - `cors`
  - `express`
  - `ffmpeg-static`
  - `ffprobe-static`
  - `fluent-ffmpeg`
  - `multer`
  - `uuid`
- Dev dependencies:
  - `@types/cors`
  - `@types/express`
  - `@types/multer`
  - `@types/node`
  - `ts-node-dev`
  - `typescript`

## 5) Frontend Dependencies (React + Vite)

Installed in `frontend/` via `npm install`:

- Runtime dependencies:
  - `axios`
  - `clsx`
  - `react`
  - `react-dom`
  - `wavesurfer.js`
  - `zustand`
- Dev dependencies:
  - `@tailwindcss/vite`
  - `@types/react`
  - `@types/react-dom`
  - `@vitejs/plugin-react`
  - `tailwindcss`
  - `typescript`
  - `vite`

## 6) Required Ports

- Frontend dev server: `5173`
- Backend API server: `4000`

Make sure these ports are available.

## 7) Required Commands

### Backend

```bash
cd backend
npm install
npm run generate:sample
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## 8) Optional but Recommended

- Modern browser: latest Chrome/Edge/Firefox
- Headphones/monitors for artifact review quality
- SSD storage for faster batch processing I/O
