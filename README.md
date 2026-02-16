# Nobo Meme Machine

Mobile-first **Instagram Outro Cutter + Meme Clip Assembler** built with **Vite + React + TypeScript**.

Everything runs in-browser with `ffmpeg.wasm` (no backend, no uploads required).

## What it does

- Import multiple clips from iPhone camera roll.
- Leave clips untouched or trim them.
- Remove Instagram outro/jingle from selected clips by trimming the last `4.55s` (default, editable).
- Batch apply actions to selected clips.
- Reorder clips with up/down controls.
- Export one stitched MP4 (H.264 video + AAC audio).
- Optional output format presets:
  - YouTube Shorts 9:16 (1080x1920)
  - Landscape 16:9 (1920x1080)
  - Square 1:1 (1080x1080)

## Local development

1. Install dependencies:

```bash
npm install
```

2. Start development server:

```bash
npm run dev
```

3. Build production bundle:

```bash
npm run build
```

4. Preview built app:

```bash
npm run preview
```

Vite outputs static files to `dist`.

## Deploy to Netlify

This repo includes `netlify.toml` configured for SPA + Vite:

- Build command: `npm run build`
- Publish directory: `dist`
- Redirect all routes to `/index.html`

### Deploy steps (Netlify UI)

1. Push this repo to GitHub.
2. Netlify → **Add new site** → **Import an existing project**.
3. Select repository.
4. Deploy (settings auto-read from `netlify.toml`).

## iPhone usage notes

- Use Safari file picker to select videos from camera roll.
- Large exports can be slow on mobile; this app warns when selection is >10 clips or >500MB.
- First export takes longer while FFmpeg core/wasm assets load in the browser.
- App keeps watermarks as-is; it only trims timeline duration.

## Deployment checklist

Before opening a PR, confirm these production settings remain unchanged:

- `package.json` build script is `vite build` (no `tsc -b` in deploy path).
- `netlify.toml` uses `command = "npm run build"` and `publish = "dist"`.
- FFmpeg core assets load from CDN using single-thread `core-st` URLs for iPhone Safari reliability.

