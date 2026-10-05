import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Annotation, Asset } from "../contract.js";
import { useText } from "./i18n.js";
import { assetLabel, mediaUrl, thumbUrl } from "./model.js";
import { BoxMark, buttonClass } from "./ui.js";
import type { Draft } from "./Viewer.js";
import {
  clampView, finishRect, fitScale, fitView, imageBox, MAX_SCALE, panBy, rectBetween, relativePoint, stageCenter, zoomTo, ZOOM_STEP,
  type Point, type Rect, type Size, type View,
} from "./zoom.js";

type BodyProps = {
  asset: Asset;
  index: number;
  total: number;
  annotations: Annotation[];
  draft: Draft | null;
  activeId: string | null;
  editable: boolean;
  onPrev: () => void;
  onNext: () => void;
  onDrawn: (rect: Rect) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
};

/** Pixels one arrow key moves the image. */
const PAN_STEP = 80;

type Gesture =
  | { kind: "pan"; from: Point; view: View }
  | { kind: "pinch"; distance: number; mid: Point; view: View }
  | { kind: "draw"; start: Point; assetId: string };

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * One proof file in the panel, in a stage of fixed height, so switching files never moves the layout. Screenshots zoom
 * and pan inside the stage; a box drawn on an editable proof becomes a draft at once.
 */
export function LightboxBody({ asset, index, total, annotations, draft, activeId, editable, onPrev, onNext, onDrawn, videoRef }: BodyProps) {
  const { t } = useText();
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [loaded, setLoaded] = useState<{ assetId: string; size: Size | null } | null>(null);
  const [view, setView] = useState<{ assetId: string; value: View } | null>(null);
  const [animate, setAnimate] = useState(false);
  // Pan first: a click into the image only focuses the stage, so the plain wheel zooms; "Markieren" turns clicks into boxes.
  const [mode, setMode] = useState<"pan" | "draw">("pan");
  const [drag, setDrag] = useState<{ start: Point; rect: Rect } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const hintId = useId();

  const zoomable = asset.kind === "image" && !asset.expired;
  const image = zoomable && loaded?.assetId === asset.id ? loaded.size : null;
  const current = image && stage && view?.assetId === asset.id ? view.value : null;
  const drawing = editable && zoomable && mode === "draw";

  useLayoutEffect(() => {
    const element = stageRef.current!;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) setStage((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new image starts fitted; a resized stage keeps the view inside its limits.
  useEffect(() => {
    if (!image || !stage) return;
    setView((previous) => ({
      assetId: asset.id,
      value: previous?.assetId === asset.id ? clampView(previous.value, image, stage) : fitView(image, stage),
    }));
  }, [asset.id, image, stage]);

  // A gesture belongs to the file it started on; switching files mid-gesture drops it.
  useEffect(() => {
    gesture.current = null;
    pointers.current.clear();
    setDrag(null);
  }, [asset.id]);

  const update = (change: (value: View, image: Size, stage: Size) => View, animated = false) => {
    if (!image || !stage) return;
    setAnimate(animated);
    setView((previous) => (previous?.assetId === asset.id ? { assetId: asset.id, value: change(previous.value, image, stage) } : previous));
  };
  const zoomBy = (factor: number, anchor?: Point, animated = false) =>
    update((value, size, area) => zoomTo(value, value.scale * factor, anchor ?? stageCenter(area), size, area), animated);
  const fit = () => update((_, size, area) => fitView(size, area), true);
  const actualSize = () => update((value, size, area) => zoomTo(value, 1, stageCenter(area), size, area), true);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const bounds = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  // React registers wheel listeners as passive; zooming must prevent the page from scrolling, so this one is native.
  // The plain wheel zooms only once the stage has focus, so scrolling the panel over the image still scrolls the panel.
  useEffect(() => {
    const element = stageRef.current!;
    const onWheel = (event: WheelEvent) => {
      if (!image || !stage) return;
      if (!event.ctrlKey && !event.metaKey && !element.contains(document.activeElement)) return;
      event.preventDefault();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      // Trackpad pinch arrives as a wheel event with ctrlKey and small deltas.
      zoomBy(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), local(event));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!current || !image || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    const touches = [...pointers.current.values()];
    if (touches.length === 2) {
      // A second finger always zooms, also while marking.
      gesture.current = { kind: "pinch", distance: distance(touches[0]!, touches[1]!), mid: midpoint(touches[0]!, touches[1]!), view: current };
      setDrag(null);
    } else if (touches.length === 1 && drawing) {
      const start = relativePoint(imageBox(current, image), local(event));
      gesture.current = { kind: "draw", start, assetId: asset.id };
      setDrag({ start, rect: rectBetween(start, start) });
    } else if (touches.length === 1) {
      gesture.current = { kind: "pan", from: local(event), view: current };
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !current || !image) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const active = gesture.current;
    if (active?.kind === "pan") {
      update((_, size, area) => panBy(active.view, point.x - active.from.x, point.y - active.from.y, size, area));
    } else if (active?.kind === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const mid = midpoint(a, b);
      update((_, size, area) => zoomTo(active.view, active.view.scale * (distance(a, b) / active.distance), active.mid, size, area, mid));
    } else if (active?.kind === "draw") {
      setDrag({ start: active.start, rect: rectBetween(active.start, relativePoint(imageBox(current, image), point)) });
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const active = gesture.current;
    if (active?.kind === "draw" && active.assetId === asset.id && current && image) {
      gesture.current = null;
      setDrag(null);
      onDrawn(finishRect(active.start, relativePoint(imageBox(current, image), local(event))));
      return;
    }
    // Lifting one finger of a pinch ends the gesture; the next touch starts a fresh one.
    if (pointers.current.size === 0 || active?.kind === "pinch") gesture.current = null;
  };
  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
    setDrag(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Leave browser zoom and shortcuts alone, and the keys of native video controls and text fields.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target instanceof HTMLMediaElement || target.isContentEditable || target.matches("textarea, select, input:not([type=checkbox])")) return;
    const { key, shiftKey } = event;
    if (key === "ArrowLeft" && !shiftKey) { if (total > 1) onPrev(); }
    else if (key === "ArrowRight" && !shiftKey) { if (total > 1) onNext(); }
    else if (key === "+" || key === "=") zoomBy(ZOOM_STEP, undefined, true);
    else if (key === "-" || key === "_") zoomBy(1 / ZOOM_STEP, undefined, true);
    else if (key === "0") fit();
    else if (key === "1") actualSize();
    else if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
      // Arrows move the view over the image, so the image itself moves the other way.
      const dx = key === "ArrowLeft" ? PAN_STEP : key === "ArrowRight" ? -PAN_STEP : 0;
      const dy = key === "ArrowUp" ? PAN_STEP : key === "ArrowDown" ? -PAN_STEP : 0;
      update((value, size, area) => panBy(value, dx, dy, size, area), true);
    } else return;
    event.preventDefault();
  };

  const rects = annotations.filter((annotation): annotation is Annotation & { anchor: Rect } => annotation.anchor.kind === "rect");
  const draftRect = drag?.rect ?? (draft?.assetId === asset.id && draft.anchor.kind === "rect" ? draft.anchor : null);
  const box = current && image ? imageBox(current, image) : null;
  const minScale = image && stage ? fitScale(image, stage) : 1;
  const percent = current ? Math.round(current.scale * 100) : null;
  const toolButton = `${buttonClass.outline} min-w-8 px-2`;

  // The toolbar shows the same controls for every file (disabled where they do not apply), so it never rewraps.
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 basis-40 truncate text-sm font-semibold text-foreground" title={asset.filename}>
          {assetLabel(asset)}
          {asset.caption && asset.caption !== asset.filename ? <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{asset.filename}</span> : null}
        </p>
        {/* Each group wraps as a whole, so a narrow window never separates − from its zoom level. */}
        <div className="inline-flex shrink-0 items-center gap-1">
          <button type="button" className={toolButton} onClick={onPrev} disabled={total < 2} aria-label={t.previousFile}>
            <span aria-hidden="true">←</span>
          </button>
          <span className="text-sm tabular-nums text-muted-foreground">{index + 1} / {total}</span>
          <button type="button" className={toolButton} onClick={onNext} disabled={total < 2} aria-label={t.nextFile}>
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="inline-flex shrink-0 items-center gap-1">
          <button type="button" className={toolButton} onClick={() => zoomBy(1 / ZOOM_STEP, undefined, true)}
            disabled={!current || current.scale <= minScale} aria-label={t.zoomOut}>
            <span aria-hidden="true">−</span>
          </button>
          <output aria-live="polite" aria-label={t.zoomLevel} className="w-14 text-center text-sm tabular-nums text-foreground">
            {percent === null ? "–" : t.percent(percent)}
          </output>
          <button type="button" className={toolButton} onClick={() => zoomBy(ZOOM_STEP, undefined, true)}
            disabled={!current || current.scale >= MAX_SCALE} aria-label={t.zoomIn}>
            <span aria-hidden="true">+</span>
          </button>
          <button type="button" className={toolButton} onClick={fit} disabled={!current}>{t.fit}</button>
          <button type="button" className={toolButton} onClick={actualSize} disabled={!current} aria-label={t.actualSize}>1:1</button>
        </div>
        {editable ? (
          <div role="group" aria-label={t.mode} className="inline-flex shrink-0 gap-1">
            <button type="button" className={`${toolButton} aria-pressed:bg-accent aria-pressed:font-semibold`} aria-pressed={mode === "pan"} disabled={!zoomable} onClick={() => setMode("pan")}>{t.pan}</button>
            <button type="button" className={`${toolButton} aria-pressed:bg-accent aria-pressed:font-semibold`} aria-pressed={mode === "draw"} disabled={!zoomable} onClick={() => setMode("draw")}>{t.mark}</button>
          </div>
        ) : null}
      </div>

      {/* The image layer would paint over an outline, so the focus ring is an overlay drawn after it, dark and light for any image. */}
      <div
        ref={stageRef}
        tabIndex={0}
        role="group"
        aria-label={t.stage(assetLabel(asset))}
        aria-describedby={hintId}
        className={`relative flex h-[60vh] min-h-64 touch-none select-none items-center justify-center overflow-hidden bg-muted outline-none focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:shadow-[inset_0_0_0_2px_var(--foreground),inset_0_0_0_4px_var(--background)] focus-visible:after:content-[''] ${
          !current ? "" : drawing ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {asset.expired ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 p-3">
            {asset.hasThumbnail ? <img src={thumbUrl(asset.sha256)} alt={t.preview(assetLabel(asset))} className="min-h-0 max-w-full flex-1 rounded object-contain opacity-60" /> : null}
            <p className="text-center text-sm text-muted-foreground">{t.mediaExpired}</p>
          </div>
        ) : asset.kind === "video" ? (
          <video ref={videoRef} src={mediaUrl(asset.sha256)} controls preload="metadata" className="max-h-full max-w-full object-contain" aria-label={assetLabel(asset)} />
        ) : loaded?.assetId === asset.id && !loaded.size ? (
          <p role="alert" className="text-sm text-destructive-text">{t.imageFailed}</p>
        ) : (
          <div
            className={`absolute left-0 top-0 ${animate ? "motion-safe:transition-[transform,width,height] motion-safe:duration-150 motion-safe:ease-out" : ""}`}
            style={box ? { width: box.width, height: box.height, transform: `translate(${box.left}px, ${box.top}px)` } : { visibility: "hidden" }}
          >
            <img
              key={asset.id}
              src={mediaUrl(asset.sha256)}
              alt={assetLabel(asset)}
              draggable={false}
              className="block h-full w-full max-w-none"
              onLoad={(event) => setLoaded({ assetId: asset.id, size: { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight } })}
              onError={() => setLoaded({ assetId: asset.id, size: null })}
            />
            {box ? rects.map((annotation) => (
              <BoxMark key={annotation.id} rect={annotation.anchor} label={String(annotation.number)} active={annotation.id === activeId} />
            )) : null}
            {box && draftRect ? <BoxMark rect={draftRect} label={t.newMark} active draft /> : null}
          </div>
        )}
      </div>

      {/* Key help for screen readers only; the controls above carry their own labels. */}
      <p id={hintId} className="sr-only">{!zoomable ? t.hintNotZoomable : drawing ? t.hintDraw : t.hintPan}</p>
    </div>
  );
}
