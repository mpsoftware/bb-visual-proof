// Browser-side rasterising: thumbnails for the audit trail and annotated copies for the implementer.
// Canvas is the native tool here; the server has no image library.
import { LIMITS, type Annotation, type Asset } from "../contract.js";
import { formatTime, mediaUrl } from "./model.js";
import { MARK_COLOR } from "./ui.js";

/** Media that never loads or seeks must not hold a send back forever. */
const LOAD_TIMEOUT_MS = 8000;
function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out.`)), LOAD_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return withTimeout(new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be loaded."));
    image.src = url;
  }), "Image load");
}

/**
 * Loads the video and seeks to `ms`. The element sits invisibly in the document while it is used, because a
 * detached video may report `seeked` before it has decoded the frame, which then draws black.
 */
function loadVideoFrame(url: string, ms: number): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.setAttribute("aria-hidden", "true");
  Object.assign(video.style, { position: "fixed", left: "-10000px", top: "0", width: "320px", opacity: "0", pointerEvents: "none" });
  document.body.append(video);
  const seeked = new Promise<HTMLVideoElement>((resolve, reject) => {
    video.onerror = () => reject(new Error("Video frame could not be loaded."));
    video.onloadeddata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.min(ms / 1000, Math.max(0, duration - 0.05));
    };
    video.onseeked = () => {
      // Wait until the seeked frame is actually presented, where the browser can tell.
      if ("requestVideoFrameCallback" in video) {
        video.requestVideoFrameCallback(() => resolve(video));
        setTimeout(() => resolve(video), 500);
      } else {
        setTimeout(() => resolve(video), 100);
      }
    };
    video.src = url;
  });
  return withTimeout(seeked, "Video seek");
}

function releaseVideo(video: HTMLVideoElement) {
  video.removeAttribute("src");
  video.load();
  video.remove();
}

/** True when a drawn frame is a single flat colour near black, i.e. nothing was decoded. */
export function isBlankFrame(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = 16;
  probe.height = 16;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(canvas, 0, 0, 16, 16);
  const data = context.getImageData(0, 0, 16, 16).data;
  let max = 0;
  for (let index = 0; index < data.length; index += 4) max = Math.max(max, data[index]!, data[index + 1]!, data[index + 2]!);
  return max < 12;
}

function canvasFor(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available.");
  return { canvas, context };
}

function toBase64(canvas: HTMLCanvasElement, type: string, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Canvas export failed."));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("Canvas export failed."));
      reader.readAsDataURL(blob);
    }, type, quality);
  });
}

const base64Bytes = (base64: string) => Math.floor((base64.length * 3) / 4);

async function drawSource(asset: Asset, ms: number, maxWidth: number, maxHeight: number) {
  const url = mediaUrl(asset.sha256);
  if (asset.kind === "image") {
    const image = await loadImage(url);
    const { canvas, context } = canvasFor(image.naturalWidth, image.naturalHeight, maxWidth, maxHeight);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, context };
  }
  // A black frame means the decoder was not ready; try again, and never send a blank image as proof.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const video = await loadVideoFrame(url, ms);
    try {
      const { canvas, context } = canvasFor(video.videoWidth, video.videoHeight, maxWidth, maxHeight);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (!isBlankFrame(canvas)) return { canvas, context };
    } finally {
      releaseVideo(video);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error("The video frame stayed black.");
}

/** A small WebP (or PNG where WebP export is missing) under the thumbnail limit; videos use the frame at one second. */
export async function makeThumbnail(asset: Asset): Promise<string> {
  for (const [maxWidth, quality] of [[480, 0.78], [320, 0.6], [200, 0.5]] as const) {
    const { canvas } = await drawSource(asset, 1000, maxWidth, maxWidth);
    const base64 = await toBase64(canvas, "image/webp", quality);
    if (base64Bytes(base64) <= LIMITS.thumbnailBytes) return base64;
  }
  throw new Error("Thumbnail stays too large.");
}

function drawLabel(context: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  context.font = `600 ${size}px system-ui, sans-serif`;
  const width = context.measureText(text).width + size * 0.8;
  const height = size * 1.5;
  const left = Math.min(Math.max(0, x), context.canvas.width - width);
  const top = Math.min(Math.max(0, y - height), context.canvas.height - height);
  context.fillStyle = MARK_COLOR;
  context.fillRect(left, top, width, height);
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(text, left + size * 0.4, top + height / 2);
}

async function exportRender(draw: (maxWidth: number) => Promise<HTMLCanvasElement>): Promise<string> {
  for (const [maxWidth, quality] of [[1600, 0.85], [1200, 0.7], [900, 0.6]] as const) {
    const base64 = await toBase64(await draw(maxWidth), "image/jpeg", quality);
    if (base64Bytes(base64) <= LIMITS.renderBytes) return base64;
  }
  throw new Error("Annotated image stays too large.");
}

/**
 * Annotated copies for a send back: one image per screenshot with its boxes, and one frame per screencast comment.
 * Returns base64 JPEGs in comment order, at most the per-send-back limit. A file that fails to render is skipped;
 * its comments still reach the implementer as text.
 */
export async function renderAnnotations(assets: readonly Asset[], annotations: readonly Annotation[]): Promise<string[]> {
  const renders: string[] = [];
  const attempt = async (render: () => Promise<string>) => {
    try {
      renders.push(await render());
    } catch {
      // Skipped; see above.
    }
  };
  for (const asset of assets) {
    if (renders.length >= LIMITS.rendersPerSendBack || asset.expired) continue;
    const own = annotations.filter((annotation) => annotation.assetId === asset.id);
    if (own.length === 0) continue;
    if (asset.kind === "image") {
      await attempt(() => exportRender(async (maxWidth) => {
        const { canvas, context } = await drawSource(asset, 0, maxWidth, maxWidth * 4);
        const line = Math.max(3, Math.round(canvas.width / 400));
        for (const annotation of own) {
          if (annotation.anchor.kind !== "rect") continue;
          const { x, y, w, h } = annotation.anchor;
          context.strokeStyle = "#ffffff";
          context.lineWidth = line + 2;
          context.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
          context.strokeStyle = MARK_COLOR;
          context.lineWidth = line;
          context.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
          drawLabel(context, String(annotation.number), x * canvas.width, y * canvas.height, Math.max(14, line * 5));
        }
        return canvas;
      }));
      continue;
    }
    for (const annotation of own) {
      if (renders.length >= LIMITS.rendersPerSendBack || annotation.anchor.kind !== "time") continue;
      const ms = annotation.anchor.ms;
      await attempt(() => exportRender(async (maxWidth) => {
        const { canvas, context } = await drawSource(asset, ms, maxWidth, maxWidth * 4);
        drawLabel(context, `${annotation.number} · ${formatTime(ms)}`, 8, 8 + Math.max(14, canvas.width / 80) * 1.5, Math.max(14, canvas.width / 80));
        return canvas;
      }));
    }
  }
  return renders;
}
