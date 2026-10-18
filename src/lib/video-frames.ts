/**
 * Deterministic video frame sampling in the browser.
 *
 * The same video always yields the same sample timestamps and the same decoded
 * frames: timestamps are fixed fractions of the analysed duration, the working
 * resolution is fixed, and frames are encoded losslessly as PNG so the forensic
 * pixel engine sees the decoder output rather than a re-compression artefact.
 */

export const FRAME_COUNT = 6;
export const MAX_ANALYSED_SECONDS = 60;
export const FRAME_MAX_EDGE = 480;

export interface SampledFrame {
  index: number;
  timestamp: number;
  /** Base64-encoded PNG bytes (no data-URL prefix). */
  pngBase64: string;
  /** Data URL for the thumbnail strip in the UI. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface VideoContainerInfo {
  durationSeconds: number;
  analysedSeconds: number;
  width: number;
  height: number;
  truncated: boolean;
}

export interface FrameExtraction {
  container: VideoContainerInfo;
  frames: SampledFrame[];
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`The video could not be decoded at ${time.toFixed(2)}s.`));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("A sampled frame could not be encoded."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Extracts FRAME_COUNT evenly spaced frames from the first
 * MAX_ANALYSED_SECONDS of the file. Reports progress as frames complete.
 */
export async function extractVideoFrames(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<FrameExtraction> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) resolve();
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("loadedmetadata", onReady);
      video.addEventListener("error", () =>
        reject(
          new Error(
            "This video could not be decoded by the browser. The file may be corrupted, or its codec is unsupported here.",
          ),
        ),
      );
      setTimeout(() => reject(new Error("The video did not become readable within 20 seconds.")), 20_000);
    });

    const duration = video.duration;
    const analysed = Math.min(duration, MAX_ANALYSED_SECONDS);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("The video reported no picture dimensions and cannot be sampled.");

    const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(width, height));
    const cw = Math.max(16, Math.round(width * scale));
    const ch = Math.max(16, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("A 2D drawing context could not be created for frame sampling.");

    const frames: SampledFrame[] = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      // Fixed fractions of the analysed window — identical for every run.
      const t = Math.min(analysed - 0.05, (analysed * (i + 0.5)) / FRAME_COUNT);
      await seek(video, Math.max(0, t));
      ctx.drawImage(video, 0, 0, cw, ch);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error(`Frame ${i + 1} could not be encoded as PNG.`);
      const pngBase64 = await blobToBase64(blob);
      frames.push({
        index: i,
        timestamp: Math.round(Math.max(0, t) * 1000) / 1000,
        pngBase64,
        dataUrl: `data:image/png;base64,${pngBase64}`,
        width: cw,
        height: ch,
      });
      onProgress?.(i + 1, FRAME_COUNT);
    }

    return {
      container: {
        durationSeconds: Math.round(duration * 1000) / 1000,
        analysedSeconds: Math.round(analysed * 1000) / 1000,
        width,
        height,
        truncated: duration > MAX_ANALYSED_SECONDS,
      },
      frames,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
