import type { Anchor, Annotation, Asset } from "../contract.js";
import { useText } from "./i18n.js";
import { LightboxBody } from "./Lightbox.js";
import { assetLabel, formatDate, formatTime } from "./model.js";
import { buttonClass, MARK_COLOR } from "./ui.js";

/** A comment being written. `keyboard` drafts start with focus on the region fields; `id` keeps the form while the region changes. */
export type Draft = { assetId: string | null; anchor: Anchor; keyboard?: boolean; id?: number };

export function Viewer({ asset, index, total, annotations, draft, activeId, editable, onPrev, onNext, onDraft, onSelectAnnotation, videoRef }: {
  asset: Asset;
  index: number;
  total: number;
  annotations: Annotation[];
  draft: Draft | null;
  activeId: string | null;
  editable: boolean;
  onPrev: () => void;
  onNext: () => void;
  onDraft: (draft: Draft) => void;
  onSelectAnnotation: (annotation: Annotation) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const { locale, t } = useText();
  const times = annotations.filter((annotation) => annotation.anchor.kind === "time");

  return (
    <section aria-label={t.fileOf(index + 1, total, assetLabel(asset))} className="space-y-2">
      <LightboxBody
        asset={asset}
        index={index}
        total={total}
        annotations={annotations}
        draft={draft}
        activeId={activeId}
        editable={editable}
        onPrev={onPrev}
        onNext={onNext}
        onDrawn={(rect) => onDraft({ assetId: asset.id, anchor: rect })}
        videoRef={videoRef}
      />

      {/* Comment actions and the screencast's time comments share one row, so switching files does not move the panel below. */}
      {(editable && !asset.expired) || times.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {editable && !asset.expired ? (
            asset.kind === "image" ? (
              <>
                <button type="button" className={buttonClass.outline}
                  onClick={() => onDraft({ assetId: asset.id, anchor: { kind: "rect", x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, keyboard: true })}>
                  {t.markRegion}
                </button>
                <button type="button" className={buttonClass.outline} onClick={() => onDraft({ assetId: asset.id, anchor: { kind: "rect", x: 0, y: 0, w: 1, h: 1 } })}>
                  {t.commentWholeImage}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={buttonClass.outline}
                onClick={() => {
                  const video = videoRef.current;
                  if (video) video.pause();
                  onDraft({ assetId: asset.id, anchor: { kind: "time", ms: Math.round((video?.currentTime ?? 0) * 1000) } });
                }}
              >
                {t.commentAtTime}
              </button>
            )
          ) : null}
          {times.length ? (
            <div role="group" className="flex flex-wrap gap-1.5" aria-label={t.screencastComments}>
              {times.map((annotation) => (
                <button key={annotation.id} type="button" onClick={() => onSelectAnnotation(annotation)}
                  className={`${buttonClass.outline} min-h-7 px-2 py-0.5 text-xs ${annotation.id === activeId ? "ring-2 ring-foreground" : ""}`}>
                  <span className="rounded-sm px-1 font-semibold text-white" style={{ background: MARK_COLOR }}>{annotation.number}</span>
                  {annotation.anchor.kind === "time" ? formatTime(annotation.anchor.ms) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {asset.expired ? <p className="text-xs text-muted-foreground">{t.uploadedOn(formatDate(asset.createdAt, locale))}</p> : null}
    </section>
  );
}
