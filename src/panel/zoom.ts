// Geometry for annotation boxes and the zoomable lightbox. Pure functions, so the maths is unit-tested without a browser.
import type { Anchor } from "../contract.js";

export type Rect = Extract<Anchor, { kind: "rect" }>;
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
/** `scale` is screen pixels per image pixel; `x`/`y` place the image's top-left corner in the stage, in screen pixels. */
export type View = { scale: number; x: number; y: number };

export const MAX_SCALE = 8;
/** One click on +/− or one key press. */
export const ZOOM_STEP = 1.25;
/** A click without dragging marks a small area around the point. */
const MIN_BOX = 0.02;
const CLICK_BOX = 0.08;

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A client point as a fraction of a box (the drawn image), kept inside it. */
export function relativePoint(bounds: { left: number; top: number; width: number; height: number }, client: Point): Point {
  return { x: clamp01((client.x - bounds.left) / bounds.width), y: clamp01((client.y - bounds.top) / bounds.height) };
}

export const rectBetween = (a: Point, b: Point): Rect =>
  ({ kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

/** The rect a finished drag marks; a click (no real drag) marks a fixed box centred on the point, inside the image. */
export function finishRect(start: Point, end: Point): Rect {
  const rect = rectBetween(start, end);
  if (rect.w >= MIN_BOX || rect.h >= MIN_BOX) return rect;
  const x = clamp01(start.x - CLICK_BOX / 2);
  const y = clamp01(start.y - CLICK_BOX / 2);
  return { kind: "rect", x: Math.min(x, 1 - CLICK_BOX), y: Math.min(y, 1 - CLICK_BOX), w: CLICK_BOX, h: CLICK_BOX };
}

/** The largest scale that shows the whole image; small images are never enlarged beyond 1:1. */
export const fitScale = (image: Size, stage: Size) => Math.min(1, stage.width / image.width, stage.height / image.height);

/** Keeps the scale between fit and MAX_SCALE; an axis smaller than the stage is centred, a larger one may not show a gap. */
export function clampView(view: View, image: Size, stage: Size): View {
  const scale = Math.min(MAX_SCALE, Math.max(fitScale(image, stage), view.scale));
  const axis = (offset: number, content: number, space: number) =>
    content <= space ? (space - content) / 2 : Math.min(0, Math.max(space - content, offset));
  return { scale, x: axis(view.x, image.width * scale, stage.width), y: axis(view.y, image.height * scale, stage.height) };
}

export const fitView = (image: Size, stage: Size): View => clampView({ scale: 0, x: 0, y: 0 }, image, stage);

/**
 * Zooms to `scale` while the image point under `anchor` (stage pixels) moves to `target`, by default staying put.
 * A pinch passes its moved midpoint as `target`, so zoom and pan are clamped once, together.
 */
export function zoomTo(view: View, scale: number, anchor: Point, image: Size, stage: Size, target: Point = anchor): View {
  const next = Math.min(MAX_SCALE, Math.max(fitScale(image, stage), scale));
  const ratio = next / view.scale;
  return clampView({ scale: next, x: target.x - (anchor.x - view.x) * ratio, y: target.y - (anchor.y - view.y) * ratio }, image, stage);
}

export const panBy = (view: View, dx: number, dy: number, image: Size, stage: Size): View =>
  clampView({ ...view, x: view.x + dx, y: view.y + dy }, image, stage);

export const stageCenter = (stage: Size): Point => ({ x: stage.width / 2, y: stage.height / 2 });

/** Where the image is drawn, in stage pixels; annotation boxes are percentages of this box. */
export const imageBox = (view: View, image: Size) =>
  ({ left: view.x, top: view.y, width: image.width * view.scale, height: image.height * view.scale });
