import { describe, expect, it } from "vitest";
import {
  clampView, finishRect, fitScale, fitView, imageBox, MAX_SCALE, panBy, relativePoint, stageCenter, zoomTo, type Point, type Rect, type View,
} from "../src/panel/zoom.js";

const image = { width: 1600, height: 1000 };
const stage = { width: 800, height: 600 };

/** Stage pixels of an image fraction at a view: the inverse of what the lightbox does with a pointer. */
const toStage = (view: View, point: Point): Point => {
  const box = imageBox(view, image);
  return { x: box.left + point.x * box.width, y: box.top + point.y * box.height };
};
/** A drag in stage pixels, mapped the way the lightbox maps pointer events. */
const drawOnStage = (view: View, from: Point, to: Point): Rect =>
  finishRect(relativePoint(imageBox(view, image), from), relativePoint(imageBox(view, image), to));

describe("zoom maths", () => {
  it("fits a large image and never enlarges a small one beyond 1:1", () => {
    expect(fitScale(image, stage)).toBe(0.5);
    expect(fitView(image, stage)).toEqual({ scale: 0.5, x: 0, y: 50 });
    expect(fitScale({ width: 200, height: 100 }, stage)).toBe(1);
    expect(fitView({ width: 200, height: 100 }, stage)).toEqual({ scale: 1, x: 300, y: 250 });
  });

  it("keeps the point under the cursor in place while zooming", () => {
    const fitted = fitView(image, stage);
    const anchor = { x: 200, y: 150 };
    const imagePoint = relativePoint(imageBox(fitted, image), anchor);
    const zoomed = zoomTo(fitted, 2, anchor, image, stage);
    expect(zoomed.scale).toBe(2);
    expect(toStage(zoomed, imagePoint)).toEqual(anchor);
  });

  it("limits the scale between fit and the maximum", () => {
    const fitted = fitView(image, stage);
    expect(zoomTo(fitted, 0.1, stageCenter(stage), image, stage)).toEqual(fitted);
    expect(zoomTo(fitted, 100, stageCenter(stage), image, stage).scale).toBe(MAX_SCALE);
  });

  it("moves and zooms a pinch together and clamps once", () => {
    const wide = { width: 1280, height: 800 };
    const area = { width: 990, height: 700 };
    // Zooming out around 495 alone would push the image past the left edge; with the midpoint moving to 435 it fits.
    const pinched = zoomTo({ scale: 1, x: -80, y: -50 }, 0.8, { x: 495, y: 350 }, wide, area, { x: 435, y: 350 });
    expect(pinched.scale).toBe(0.8);
    expect(pinched.x).toBeCloseTo(-25, 9);
  });

  it("pans only as far as the image reaches and centres an axis smaller than the stage", () => {
    const actual = zoomTo(fitView(image, stage), 1, stageCenter(stage), image, stage);
    expect(actual).toEqual({ scale: 1, x: -400, y: -200 });
    expect(panBy(actual, 10_000, 10_000, image, stage)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(panBy(actual, -10_000, -10_000, image, stage)).toEqual({ scale: 1, x: -800, y: -400 });
    // At fit the image fills the width and is less tall than the stage, so it stays vertically centred.
    expect(panBy(fitView(image, stage), 0, 120, image, stage)).toEqual({ scale: 0.5, x: 0, y: 50 });
    expect(clampView({ scale: 0.6, x: 999, y: -999 }, image, stage)).toEqual({ scale: 0.6, x: 0, y: 0 });
  });
});

describe("annotation mapping at any zoom", () => {
  const rect: Rect = { kind: "rect", x: 0.5, y: 0.25, w: 0.1, h: 0.2 };
  const views: Array<[string, View]> = [
    ["fit", fitView(image, stage)],
    ["1:1 centred", zoomTo(fitView(image, stage), 1, stageCenter(stage), image, stage)],
    ["4x, panned", panBy(zoomTo(fitView(image, stage), 4, { x: 100, y: 500 }, image, stage), -37, 21, image, stage)],
  ];

  it.each(views)("a box drawn on screen at %s is stored relative to the image", (_, view) => {
    const from = toStage(view, { x: rect.x, y: rect.y });
    const to = toStage(view, { x: rect.x + rect.w, y: rect.y + rect.h });
    const drawn = drawOnStage(view, from, to);
    for (const key of ["x", "y", "w", "h"] as const) expect(drawn[key]).toBeCloseTo(rect[key], 10);
  });

  it("keeps a drag that leaves the image inside it", () => {
    const view = zoomTo(fitView(image, stage), 2, stageCenter(stage), image, stage);
    const drawn = drawOnStage(view, toStage(view, { x: 0.45, y: 0.45 }), { x: 5_000, y: -5_000 });
    expect(drawn).toEqual({ kind: "rect", x: 0.45, y: 0, w: 0.55, h: 0.45 });
  });

  it("turns a click into a fixed box inside the image", () => {
    expect(finishRect({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toEqual({ kind: "rect", x: 0.46, y: 0.46, w: 0.08, h: 0.08 });
    expect(finishRect({ x: 0.99, y: 0.01 }, { x: 0.99, y: 0.01 })).toEqual({ kind: "rect", x: 0.92, y: 0, w: 0.08, h: 0.08 });
  });
});
