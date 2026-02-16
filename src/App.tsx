import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

type FitMode = 'cover' | 'contain';
type AspectPresetKey = 'shorts' | 'landscape' | 'square';

type Clip = {
  id: string;
  file: File;
  name: string;
  duration: number;
  include: boolean;
  trimEnabled: boolean;
  trimStart: number;
  trimEnd: number;
  removeOutroEnabled: boolean;
  outroSeconds: number;
  selected: boolean;
  previewUrl: string;
};

type AspectPreset = {
  label: string;
  width: number;
  height: number;
};

type EffectiveRange = {
  start: number;
  end: number;
  valid: boolean;
  reason: string;
};

const ASPECT_PRESETS: Record<AspectPresetKey, AspectPreset> = {
  shorts: { label: 'YouTube Shorts (9:16) — 1080x1920', width: 1080, height: 1920 },
  landscape: { label: 'Landscape (16:9) — 1920x1080', width: 1920, height: 1080 },
  square: { label: 'Square (1:1) — 1080x1080', width: 1080, height: 1080 },
};

const MAX_CLIPS = 30;
const LARGE_SIZE_BYTES = 500 * 1024 * 1024;

const getVideoDuration = (file: File): Promise<number> =>
  new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.playsInline = true;
    const objectUrl = URL.createObjectURL(file);

    video.src = objectUrl;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Could not read video metadata for ${file.name}`));
    };
  });

const toSafeName = (name: string, fallback: string): string => {
  const base = name.replace(/\.[^/.]+$/, '');
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || fallback;
};

const getScaleFilter = (preset: AspectPreset, fitMode: FitMode): string => {
  if (fitMode === 'cover') {
    return `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=increase,crop=${preset.width}:${preset.height}`;
  }

  return `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`;
};

const safeDeleteFile = async (ffmpeg: FFmpeg, fileName: string) => {
  try {
    await ffmpeg.deleteFile(fileName);
  } catch {
    // Ignore cleanup errors
  }
};

function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [globalOutroSeconds, setGlobalOutroSeconds] = useState(4.55);
  const [aspectPresetKey, setAspectPresetKey] = useState<AspectPresetKey>('shorts');
  const [fitMode, setFitMode] = useState<FitMode>('contain');
  const [isFfmpegLoading, setIsFfmpegLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [currentStep, setCurrentStep] = useState('');
  const [exportProgress, setExportProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [warningMessage, setWarningMessage] = useState('');
  const [outputUrl, setOutputUrl] = useState('');

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const ffmpegLoadedRef = useRef(false);
  const progressBaseRef = useRef(0);
  const progressWeightRef = useRef(0);

  const clipsRef = useRef<Clip[]>([]);
  const outputUrlRef = useRef('');

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    outputUrlRef.current = outputUrl;
  }, [outputUrl]);

  useEffect(() => {
    return () => {
      clipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.previewUrl));
      if (outputUrlRef.current) {
        URL.revokeObjectURL(outputUrlRef.current);
      }
    };
  }, []);

  const selectedCount = useMemo(() => clips.filter((clip) => clip.selected).length, [clips]);
  const includedClips = useMemo(() => clips.filter((clip) => clip.include), [clips]);

  const getEffectiveRange = (clip: Clip): EffectiveRange => {
    if (!clip.trimEnabled) {
      return {
        start: 0,
        end: clip.duration,
        valid: clip.duration > 0,
        reason: clip.duration > 0 ? '' : 'Clip has no readable duration.',
      };
    }

    const start = clip.trimStart;
    const end = clip.removeOutroEnabled ? Math.max(0, clip.duration - clip.outroSeconds) : clip.trimEnd;

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { start, end, valid: false, reason: 'Trim values must be numeric.' };
    }

    if (start < 0) {
      return { start, end, valid: false, reason: 'Trim start cannot be negative.' };
    }

    if (end > clip.duration) {
      return { start, end, valid: false, reason: 'Trim end cannot exceed clip duration.' };
    }

    if (end <= start) {
      return {
        start,
        end,
        valid: false,
        reason: 'Trim end must be greater than trim start. Reduce outro seconds or adjust start.',
      };
    }

    return { start, end, valid: true, reason: '' };
  };

  useEffect(() => {
    const totalIncludedSize = includedClips.reduce((sum, clip) => sum + clip.file.size, 0);
    const shouldWarn = includedClips.length > 10 || totalIncludedSize > LARGE_SIZE_BYTES;

    if (shouldWarn) {
      setWarningMessage(
        'Large export selected. iPhone Safari may run slowly or run out of memory for more than 10 clips or 500MB.',
      );
      return;
    }

    setWarningMessage('');
  }, [includedClips]);

  const onImportVideos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    if (clips.length + files.length > MAX_CLIPS) {
      setErrorMessage(`Too many clips selected. Limit is ${MAX_CLIPS} clips.`);
      return;
    }

    setErrorMessage('');

    try {
      const loadedClips = await Promise.all(
        files.map(async (file, index) => {
          const duration = await getVideoDuration(file);
          const previewUrl = URL.createObjectURL(file);

          return {
            id: `${Date.now()}_${index}_${Math.random().toString(36).slice(2, 9)}`,
            file,
            name: file.name,
            duration,
            include: true,
            trimEnabled: true,
            trimStart: 0,
            trimEnd: duration,
            removeOutroEnabled: false,
            outroSeconds: globalOutroSeconds,
            selected: false,
            previewUrl,
          } as Clip;
        }),
      );

      setClips((prev) => [...prev, ...loadedClips]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to import videos.');
    }
  };

  const updateClip = (id: string, updater: (clip: Clip) => Clip) => {
    setClips((prev) => prev.map((clip) => (clip.id === id ? updater(clip) : clip)));
  };

  const moveClip = (index: number, direction: -1 | 1) => {
    setClips((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const setSelectedState = (selected: boolean) => {
    setClips((prev) => prev.map((clip) => ({ ...clip, selected })));
  };

  const batchUpdateSelected = (updater: (clip: Clip) => Clip) => {
    setClips((prev) => prev.map((clip) => (clip.selected ? updater(clip) : clip)));
  };

  const ensureFfmpeg = async (): Promise<FFmpeg> => {
    if (!ffmpegRef.current) {
      ffmpegRef.current = new FFmpeg();
      ffmpegRef.current.on('progress', ({ progress }) => {
        const estimate = progressBaseRef.current + progress * progressWeightRef.current;
        setExportProgress(Math.min(99, Math.max(1, Math.round(estimate))));
      });
    }

    if (!ffmpegLoadedRef.current) {
      setIsFfmpegLoading(true);

      try {
        await ffmpegRef.current.load({
          coreURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
          wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
        });
        ffmpegLoadedRef.current = true;
      } catch (error) {
        throw new Error(error instanceof Error ? `Failed to load FFmpeg: ${error.message}` : 'Failed to load FFmpeg.');
      } finally {
        setIsFfmpegLoading(false);
      }
    }

    return ffmpegRef.current;
  };

  const handleExport = async () => {
    setErrorMessage('');

    if (includedClips.length === 0) {
      setErrorMessage('Include at least one clip before exporting.');
      return;
    }

    const invalidIncluded = includedClips.find((clip) => !getEffectiveRange(clip).valid);
    if (invalidIncluded) {
      const range = getEffectiveRange(invalidIncluded);
      setErrorMessage(`Cannot export: ${invalidIncluded.name} has invalid trim settings. ${range.reason}`);
      return;
    }

    if (outputUrl) {
      URL.revokeObjectURL(outputUrl);
      setOutputUrl('');
    }

    setIsExporting(true);
    setCurrentStep('Loading FFmpeg…');
    setExportProgress(0);

    const generatedFiles: string[] = [];

    try {
      const ffmpeg = await ensureFfmpeg();
      const preset = ASPECT_PRESETS[aspectPresetKey];
      const scaleFilter = getScaleFilter(preset, fitMode);

      for (let i = 0; i < includedClips.length; i += 1) {
        const clip = includedClips[i];
        const range = getEffectiveRange(clip);

        const ext = clip.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
        const inputName = `${toSafeName(clip.name, `clip_${i}`)}_${i}.${ext}`;
        const outputName = `segment_${i}.mp4`;

        setCurrentStep(`Processing clip ${i + 1} of ${includedClips.length}…`);

        progressWeightRef.current = 90 / includedClips.length;
        progressBaseRef.current = (i / includedClips.length) * 90;

        await ffmpeg.writeFile(inputName, await fetchFile(clip.file));

        const args = [
          '-ss',
          range.start.toFixed(3),
          '-to',
          range.end.toFixed(3),
          '-i',
          inputName,
          '-vf',
          scaleFilter,
          '-pix_fmt',
          'yuv420p',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          outputName,
        ];

        await ffmpeg.exec(args);

        generatedFiles.push(inputName, outputName);
      }

      setCurrentStep('Concatenating clips…');
      const listContent = includedClips.map((_, index) => `file 'segment_${index}.mp4'`).join('\n');
      await ffmpeg.writeFile('concat_list.txt', new TextEncoder().encode(listContent));
      generatedFiles.push('concat_list.txt', 'nobo_meme_machine_output.mp4');

      await ffmpeg.exec([
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'concat_list.txt',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        'nobo_meme_machine_output.mp4',
      ]);

      const outputData = await ffmpeg.readFile('nobo_meme_machine_output.mp4');
      if (!(outputData instanceof Uint8Array)) {
        throw new Error('Unexpected FFmpeg output format.');
      }

      const finalBlob = new Blob([new Uint8Array(outputData)], { type: 'video/mp4' });
      const finalUrl = URL.createObjectURL(finalBlob);
      setOutputUrl(finalUrl);

      setExportProgress(100);
      setCurrentStep('Export complete. Ready to download.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      const ffmpeg = ffmpegRef.current;
      if (ffmpeg) {
        for (const fileName of generatedFiles) {
          await safeDeleteFile(ffmpeg, fileName);
        }
      }
      setIsExporting(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="card hero-card">
        <h1>Nobo Meme Machine</h1>
        <p>Instagram Outro Cutter + Meme Clip Assembler (client-side only).</p>
      </header>

      <section className="card">
        <label className="file-upload">
          <span>Import meme clips</span>
          <input type="file" accept="video/*" multiple onChange={onImportVideos} />
        </label>
        <p className="meta">iPhone camera roll friendly. Max {MAX_CLIPS} clips.</p>
      </section>

      <section className="card controls-grid global-grid">
        <label>
          IG outro seconds (global)
          <input
            type="number"
            min={0}
            step={0.01}
            value={globalOutroSeconds}
            onChange={(event) => setGlobalOutroSeconds(Number(event.target.value) || 0)}
          />
        </label>

        <label>
          Export preset
          <select value={aspectPresetKey} onChange={(event) => setAspectPresetKey(event.target.value as AspectPresetKey)}>
            {Object.entries(ASPECT_PRESETS).map(([key, preset]) => (
              <option key={key} value={key}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Fit mode
          <select value={fitMode} onChange={(event) => setFitMode(event.target.value as FitMode)}>
            <option value="contain">Contain (pad)</option>
            <option value="cover">Cover (crop)</option>
          </select>
        </label>
      </section>

      <section className="card batch-actions">
        <h2>Batch actions</h2>
        <div className="button-row wrap">
          <button type="button" onClick={() => setSelectedState(true)}>
            Select all
          </button>
          <button type="button" onClick={() => setSelectedState(false)}>
            Select none
          </button>
          <button
            type="button"
            onClick={() => batchUpdateSelected((clip) => ({ ...clip, removeOutroEnabled: true, trimEnabled: true }))}
          >
            Apply Remove IG Outro
          </button>
          <button type="button" onClick={() => batchUpdateSelected((clip) => ({ ...clip, removeOutroEnabled: false }))}>
            Clear Remove IG Outro
          </button>
          <button type="button" onClick={() => batchUpdateSelected((clip) => ({ ...clip, trimEnabled: true }))}>
            Enable Trim
          </button>
          <button type="button" onClick={() => batchUpdateSelected((clip) => ({ ...clip, trimEnabled: false }))}>
            Disable Trim
          </button>
          <button
            type="button"
            onClick={() => batchUpdateSelected((clip) => ({ ...clip, outroSeconds: globalOutroSeconds }))}
          >
            Apply global outro secs
          </button>
        </div>
        <p className="meta">Selected clips: {selectedCount}</p>
      </section>

      <section className="clip-list">
        {clips.length === 0 ? (
          <div className="card empty-state">No clips imported yet.</div>
        ) : (
          clips.map((clip, index) => {
            const range = getEffectiveRange(clip);
            return (
              <article className="card clip-card" key={clip.id}>
                <video src={clip.previewUrl} playsInline controls preload="metadata" />

                <div className="clip-header">
                  <h3>{clip.name}</h3>
                  <p>Duration: {clip.duration.toFixed(2)}s</p>
                </div>

                <div className="row">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={clip.selected}
                      onChange={(event) => updateClip(clip.id, (curr) => ({ ...curr, selected: event.target.checked }))}
                    />
                    Selected
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={clip.include}
                      onChange={(event) => updateClip(clip.id, (curr) => ({ ...curr, include: event.target.checked }))}
                    />
                    Include
                  </label>
                  <div className="button-row">
                    <button type="button" onClick={() => moveClip(index, -1)} disabled={index === 0}>
                      ↑ Up
                    </button>
                    <button type="button" onClick={() => moveClip(index, 1)} disabled={index === clips.length - 1}>
                      ↓ Down
                    </button>
                  </div>
                </div>

                <div className="row wrap">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={clip.trimEnabled}
                      onChange={(event) => updateClip(clip.id, (curr) => ({ ...curr, trimEnabled: event.target.checked }))}
                    />
                    Trim Enabled
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={clip.removeOutroEnabled}
                      onChange={(event) =>
                        updateClip(clip.id, (curr) => ({
                          ...curr,
                          removeOutroEnabled: event.target.checked,
                          trimEnabled: event.target.checked ? true : curr.trimEnabled,
                        }))
                      }
                    />
                    Remove IG Outro
                  </label>
                </div>

                {clip.trimEnabled && (
                  <div className="controls-grid clip-grid">
                    <label>
                      Trim start (s)
                      <input
                        type="number"
                        min={0}
                        max={clip.duration}
                        step={0.01}
                        value={clip.trimStart}
                        onChange={(event) =>
                          updateClip(clip.id, (curr) => ({ ...curr, trimStart: Number(event.target.value) || 0 }))
                        }
                      />
                    </label>

                    <label>
                      Trim end (s)
                      <input
                        type="number"
                        min={0}
                        max={clip.duration}
                        step={0.01}
                        value={clip.removeOutroEnabled ? Math.max(0, clip.duration - clip.outroSeconds) : clip.trimEnd}
                        onChange={(event) =>
                          updateClip(clip.id, (curr) => ({ ...curr, trimEnd: Number(event.target.value) || 0 }))
                        }
                        disabled={clip.removeOutroEnabled}
                      />
                    </label>

                    <label>
                      Outro seconds (clip)
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={clip.outroSeconds}
                        onChange={(event) =>
                          updateClip(clip.id, (curr) => ({ ...curr, outroSeconds: Number(event.target.value) || 0 }))
                        }
                      />
                    </label>
                  </div>
                )}

                <p className="meta">
                  Effective export range: {range.start.toFixed(2)}s → {range.end.toFixed(2)}s
                  {!clip.trimEnabled ? ' (Untouched full clip)' : ''}
                </p>
                {!range.valid && <p className="error">{range.reason}</p>}
              </article>
            );
          })
        )}
      </section>

      <section className="card export-card">
        <button type="button" className="primary" onClick={handleExport} disabled={isFfmpegLoading || isExporting}>
          {isFfmpegLoading ? 'Loading FFmpeg…' : isExporting ? 'Exporting…' : 'Export stitched MP4'}
        </button>

        <p className="meta">Included clips: {includedClips.length}</p>
        {warningMessage && <p className="warning">{warningMessage}</p>}
        {(isExporting || exportProgress > 0) && (
          <>
            <p className="meta">{currentStep}</p>
            <div className="progress-track" aria-label="Export progress bar">
              <div className="progress-fill" style={{ width: `${exportProgress}%` }} />
            </div>
            <p className="meta">Progress: {exportProgress}%</p>
          </>
        )}

        {outputUrl && (
          <a className="download-link" href={outputUrl} download="nobo_meme_machine_export.mp4">
            Download final MP4
          </a>
        )}

        {errorMessage && <p className="error">{errorMessage}</p>}
      </section>
    </main>
  );
}

export default App;
