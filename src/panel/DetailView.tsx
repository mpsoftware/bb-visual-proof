import { useEffect, useId, useRef, useState } from "react";
import { LIMITS, type Anchor, type Annotation, type Asset, type Delivery, type ProofSet, type SetDetail } from "../contract.js";
import { useLoader, useProofRpc, useThumbnailBackfill, type ProofRpc } from "./hooks.js";
import { useText, type I18n } from "./i18n.js";
import { PreviewTile } from "./ListView.js";
import {
  anchorLabel, assetLabel, countsLabel, errorMessage, formatBytes, formatDate, formatDateTime, shortSha, statusOf, type Notice,
} from "./model.js";
import { renderAnnotations } from "./render.js";
import { Age, buttonClass, Dialog, DialogClose, ErrorState, fieldClass, focusRing, inputClass, LoadingState, MARK_COLOR, StatusBadge } from "./ui.js";
import { Viewer, type Draft } from "./Viewer.js";

type Props = {
  repository: string;
  number: number;
  setId?: string;
  refreshKey: number;
  now: number;
  announce: (notice: Notice) => void;
  onBack: () => void;
  onSelectSet: (setId: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenUrl: (url: string) => void;
};

const withWarnings = (text: string, warnings: string[], locale: I18n["locale"]): Notice =>
  warnings.length ? { tone: "warning", text: `${text}\n${warnings.map((warning) => errorMessage(warning, locale)).join("\n")}` } : { tone: "success", text };

/** Media text for a set: when it will be or was removed. */
function mediaFate(set: ProofSet, assets: Asset[], now: number, { locale, t }: I18n): string | null {
  if (assets.length > 0 && assets.every((asset) => asset.expired)) return t.mediaDeleted;
  if (!set.mediaExpiresAt) return null;
  return Date.parse(set.mediaExpiresAt) <= now ? t.mediaDeletedNextSweep : t.mediaDeletedOn(formatDate(set.mediaExpiresAt, locale));
}

export function DetailView(props: Props) {
  const { repository, number, setId, refreshKey, announce, onBack } = props;
  const rpc = useProofRpc();
  const { locale, t } = useText();
  const { state, retry, refresh } = useLoader(
    () => rpc.call("proofs_detail", { repository, number, ...(setId ? { setId } : {}) }),
    [refreshKey, repository, number, setId],
  );
  const back = (
    <button type="button" className={buttonClass.ghost} onClick={onBack}>
      <span aria-hidden="true">←</span> {t.allProofs}
    </button>
  );
  if (state.status === "loading") return <div className="space-y-3">{back}<LoadingState label={t.detailLoading} /></div>;
  if (state.status === "error") return <div className="space-y-3">{back}<ErrorState title={t.detailError} message={errorMessage(state.message, locale)} onRetry={retry} /></div>;
  const { detail } = state.value;
  if (!detail) {
    return (
      <div className="space-y-3">
        {back}
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {t.noProof(`${repository} #${number}`, Boolean(setId))}
        </div>
      </div>
    );
  }
  return (
    <LoadedDetail
      {...props}
      key={detail.set.id}
      detail={detail}
      rpc={rpc}
      back={back}
      refreshError={state.refreshError}
      postCommitStatus={state.value.postCommitStatus}
      onChanged={refresh}
      announce={announce}
    />
  );
}

function LoadedDetail({ detail, rpc, back, refreshError, postCommitStatus, now, announce, onChanged, onSelectSet, onOpenThread, onOpenUrl }: Props & {
  detail: SetDetail;
  rpc: ProofRpc;
  back: React.ReactNode;
  refreshError: string | null;
  postCommitStatus: boolean;
  onChanged: () => void;
}) {
  const { set, assets, annotations, history } = detail;
  const i18n = useText();
  const { locale, t } = i18n;
  const editable = !set.stale && set.status !== "approved";
  const [index, setIndex] = useState(0);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftCounter = useRef(0);
  // A new draft gets a fresh id (fresh form); region edits keep the id, so the typed comment survives them.
  const setDraft = (next: Draft | null | ((current: Draft | null) => Draft | null)) =>
    setDraftState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      return value && value.id === undefined ? { ...value, id: ++draftCounter.current } : value;
    });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const historyId = useId();
  useThumbnailBackfill(assets);

  const asset = assets[Math.min(index, assets.length - 1)] ?? null;
  const select = (next: number) => {
    setIndex((next + assets.length) % assets.length);
    setDraft((current) => (current?.assetId === null ? current : null));
  };
  const selectAnnotation = (annotation: Annotation) => {
    setActiveId(annotation.id);
    const target = assets.findIndex((candidate) => candidate.id === annotation.assetId);
    if (target >= 0 && target !== index) setIndex(target);
    if (annotation.anchor.kind === "time") {
      const ms = annotation.anchor.ms;
      // The video element mounts after an index change; seek on the next frame.
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.currentTime = ms / 1000;
      });
    }
  };

  const checkHead = async () => {
    setChecking(true);
    try {
      const result = await rpc.call("proofs_check_head", { repository: set.repository, number: set.number });
      announce(result.headSha === set.headSha
        ? { tone: "success", text: t.headUnchanged(shortSha(set.headSha), result.prState.toLowerCase()) }
        : { tone: "warning", text: t.headMoved(shortSha(result.headSha)) });
      onChanged();
    } catch (error) {
      announce({ tone: "error", text: t.headCheckFailed(errorMessage(error, locale)) });
    } finally {
      setChecking(false);
    }
  };

  const status = statusOf(set, t);
  const newest = history[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap items-center gap-1.5">
          {set.threadId ? <button type="button" className={buttonClass.outline} onClick={() => onOpenThread(set.threadId!)}>{t.implementerThread}</button> : null}
          <button type="button" className={buttonClass.outline} onClick={() => onOpenUrl(set.prUrl)}>
            GitHub <span aria-hidden="true">↗</span>
          </button>
          <button type="button" className={buttonClass.outline} onClick={() => void checkHead()} disabled={checking}>
            {checking ? t.checkingHead : t.checkHead}
          </button>
        </div>
      </div>

      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={status.tone} label={status.label} />
          <span className="text-xs text-muted-foreground">{set.repository} #{set.number}</span>
          <span className="text-xs text-muted-foreground">{countsLabel(set, t)} · {formatBytes(set.bytes, locale)}</span>
          <span className="text-xs text-muted-foreground">{t.updated} <Age iso={set.updatedAt} now={now} /></span>
        </div>
        <h1 className="text-base font-semibold leading-6 text-foreground">{set.prTitle}</h1>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor={historyId} className="shrink-0 font-medium text-foreground">{t.headLabel}</label>
          <select id={historyId} value={set.id} onChange={(event) => onSelectSet(event.currentTarget.value)} className={`${fieldClass} min-w-0 max-w-full font-mono text-xs`}>
            {history.map((entry) => <option key={entry.id} value={entry.id}>{historyLabel(entry, entry.id === newest?.id, i18n)}</option>)}
          </select>
        </div>
      </header>

      {refreshError ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-text">{t.refreshFailed(errorMessage(refreshError, locale))}</div>
      ) : null}
      <SetBanner set={set} assets={assets} now={now} newest={newest} onSelectSet={onSelectSet} />

      {assets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">{t.noFilesInSet}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-3">
            <Viewer
              asset={asset!}
              index={Math.min(index, assets.length - 1)}
              total={assets.length}
              annotations={annotations.filter((annotation) => annotation.assetId === asset!.id)}
              draft={draft}
              activeId={activeId}
              editable={editable}
              onPrev={() => select(index - 1)}
              onNext={() => select(index + 1)}
              onDraft={(next) => setDraft(next)}
              onSelectAnnotation={selectAnnotation}
              videoRef={videoRef}
            />
            <Filmstrip assets={assets} annotations={annotations} index={index} onSelect={select} />
          </div>
          <aside aria-label={t.commentsAndDecision} className="min-w-0 space-y-4">
            <Comments
              set={set}
              assets={assets}
              annotations={annotations}
              draft={draft}
              activeId={activeId}
              editable={editable}
              rpc={rpc}
              onDraft={(next) => setDraft(next)}
              onRegion={(anchor) => setDraft((current) => (current ? { ...current, anchor } : current))}
              onSelect={selectAnnotation}
              onChanged={onChanged}
              announce={announce}
            />
            <DeliveryNotice set={set} deliveries={detail.deliveries} postCommitStatus={postCommitStatus} rpc={rpc} announce={announce} onChanged={onChanged} />
            <Decision set={set} assets={assets} annotations={annotations} editable={editable} postCommitStatus={postCommitStatus} rpc={rpc} announce={announce} onChanged={onChanged} />
          </aside>
        </div>
      )}
      <StorageLine set={set} assets={assets} rpc={rpc} announce={announce} onChanged={onChanged} />
    </div>
  );
}

function historyLabel(set: ProofSet, isNewest: boolean, { locale, t }: I18n): string {
  // An outdated head keeps its last decision in the label, for the audit trail.
  const decided = set.status === "approved" ? t.historyWasApproved : set.status === "changes_requested" ? t.historySentBack : "";
  const state = `${statusOf(set, t).label.toLowerCase()}${set.stale ? decided : ""}`;
  return `${shortSha(set.headSha)} · ${isNewest ? t.historyNewest : ""}${state}${set.round > 1 ? ` · ${t.round(set.round)}` : ""} · ${formatDate(set.createdAt, locale)}`;
}

function SetBanner({ set, assets, now, newest, onSelectSet }: {
  set: ProofSet; assets: Asset[]; now: number; newest: ProofSet | undefined; onSelectSet: (setId: string) => void;
}) {
  const i18n = useText();
  const { locale, t } = i18n;
  const fate = mediaFate(set, assets, now, i18n);
  if (set.stale) {
    const moved = set.staleReason === "head_moved";
    return (
      <div className="rounded-md border border-attention bg-attention/15 px-3 py-2 text-sm text-foreground">
        <p className="font-medium">{t.staleTitle}</p>
        <p className="mt-0.5 text-muted-foreground">
          {moved && set.currentHeadSha
            ? t.staleMoved(shortSha(set.currentHeadSha))
            : t.staleReplaced}
          {fate ? ` ${fate}` : ""}
        </p>
        {newest && newest.id !== set.id ? (
          <button type="button" className={`${buttonClass.link} mt-1`} onClick={() => onSelectSet(newest.id)}>{t.toNewest(shortSha(newest.headSha))}</button>
        ) : null}
      </div>
    );
  }
  if (set.status === "approved" && set.decidedAt) {
    return (
      <div className="rounded-md border border-success/50 bg-success/10 px-3 py-2 text-sm text-foreground">
        <p className="font-medium">{t.approvedOn(formatDateTime(set.decidedAt, locale), shortSha(set.headSha))}</p>
        {set.decisionNote ? <p className="mt-0.5 whitespace-pre-line text-muted-foreground">{set.decisionNote}</p> : null}
        {!set.threadId ? <p className="mt-0.5 text-muted-foreground">{t.approvedNoThread}</p> : null}
        {fate ? <p className="mt-0.5 text-muted-foreground">{fate}</p> : null}
      </div>
    );
  }
  if (set.status === "changes_requested" && set.decidedAt) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-foreground">
        <p className="font-medium">{t.sentBackOn(formatDateTime(set.decidedAt, locale), set.round - 1)}</p>
        <p className="mt-0.5 text-muted-foreground">{t.sentBackNext}</p>
      </div>
    );
  }
  return null;
}

function Filmstrip({ assets, annotations, index, onSelect }: { assets: Asset[]; annotations: Annotation[]; index: number; onSelect: (index: number) => void }) {
  const { t } = useText();
  if (assets.length < 2) return null;
  return (
    <ul className="flex gap-2 overflow-x-auto px-1 pb-1 pt-2" aria-label={t.files}>
      {assets.map((asset, position) => {
        const count = annotations.filter((annotation) => annotation.assetId === asset.id).length;
        return (
          <li key={asset.id}>
            <button type="button" onClick={() => onSelect(position)} aria-current={position === index ? "true" : undefined}
              aria-label={count ? t.fileWithComments(assetLabel(asset), count) : assetLabel(asset)}
              className={`relative block rounded ${focusRing} ${position === index ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "opacity-80 hover:opacity-100"}`}>
              <PreviewTile asset={asset} size="md" />
              {count ? <span className="absolute -right-1 -top-1 rounded-full px-1.5 text-[10px] font-semibold leading-4 text-white" style={{ background: MARK_COLOR }}>{count}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Comments({ set, assets, annotations, draft, activeId, editable, rpc, onDraft, onRegion, onSelect, onChanged, announce }: {
  set: ProofSet;
  assets: Asset[];
  annotations: Annotation[];
  draft: Draft | null;
  activeId: string | null;
  editable: boolean;
  rpc: ProofRpc;
  onDraft: (draft: Draft | null) => void;
  onRegion: (anchor: Extract<Anchor, { kind: "rect" }>) => void;
  onSelect: (annotation: Annotation) => void;
  onChanged: () => void;
  announce: (notice: Notice) => void;
}) {
  const headingId = useId();
  const { t } = useText();
  const where = (annotation: Pick<Annotation, "assetId" | "anchor">) => {
    const asset = assets.find((candidate) => candidate.id === annotation.assetId);
    return asset ? `${assetLabel(asset)} · ${anchorLabel(annotation.anchor, t)}` : t.wholeSet;
  };
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">{t.commentsHeading(annotations.length)}</h2>
        {editable && !draft ? (
          <button type="button" className={`${buttonClass.ghost} min-h-7 px-2 py-0.5`} onClick={() => onDraft({ assetId: null, anchor: { kind: "none" } })}>
            {t.addGeneral}
          </button>
        ) : null}
      </div>
      {draft ? (
        <DraftForm key={draft.id} setId={set.id} draft={draft} label={where(draft)} rpc={rpc} onRegion={onRegion}
          onDone={(saved) => { onDraft(null); if (saved) { announce({ tone: "success", text: t.commentSaved(saved.number) }); onChanged(); } }} />
      ) : null}
      {annotations.length === 0 && !draft ? (
        <p className="mt-2 text-sm text-muted-foreground">{editable ? t.noCommentsEditable : t.noComments}</p>
      ) : null}
      <ol className="mt-2 space-y-2">
        {annotations.map((annotation) => (
          <CommentItem key={annotation.id} annotation={annotation} where={where(annotation)} active={annotation.id === activeId}
            editable={editable && !annotation.locked} rpc={rpc} onSelect={() => onSelect(annotation)} onChanged={onChanged} announce={announce} />
        ))}
      </ol>
    </section>
  );
}

function DraftForm({ setId, draft, label, rpc, onRegion, onDone }: {
  setId: string; draft: Draft; label: string; rpc: ProofRpc;
  onRegion: (anchor: Extract<Anchor, { kind: "rect" }>) => void;
  onDone: (saved: Annotation | null) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const { locale, t } = useText();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await rpc.call("proofs_annotation_add", { setId, assetId: draft.assetId, anchor: draft.anchor, body }));
    } catch (cause) {
      setError(errorMessage(cause, locale));
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-dashed p-2"
      style={{ borderColor: MARK_COLOR }}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => { if (event.key === "Escape") onDone(null); }}
    >
      {draft.anchor.kind === "rect" ? <RegionFields rect={draft.anchor} autoFocus={draft.keyboard === true} onChange={onRegion} /> : null}
      <label htmlFor={fieldId} className="block text-xs font-medium text-foreground">{t.newComment(label)}</label>
      <textarea id={fieldId} autoFocus={draft.keyboard !== true} rows={3} value={body} maxLength={LIMITS.commentChars} onChange={(event) => setBody(event.currentTarget.value)}
        className={inputClass} placeholder={t.commentPlaceholder} />
      {error ? <p role="alert" className="text-xs text-destructive-text">{error}</p> : null}
      <div className="flex gap-2">
        <button type="submit" className={buttonClass.primary} disabled={busy || !body.trim()}>{busy ? t.saving : t.save}</button>
        <button type="button" className={buttonClass.ghost} onClick={() => onDone(null)}>{t.cancel}</button>
      </div>
    </form>
  );
}

type Rect = Extract<Anchor, { kind: "rect" }>;
const REGION_FIELDS: Array<{ key: "x" | "y" | "w" | "h"; label: "regionLeft" | "regionTop" | "regionWidth" | "regionHeight" }> = [
  { key: "x", label: "regionLeft" }, { key: "y", label: "regionTop" }, { key: "w", label: "regionWidth" }, { key: "h", label: "regionHeight" },
];

/**
 * Keyboard access to the marked region: position and size in percent of the image. The box on the image follows
 * every change; values are kept inside the image.
 */
function RegionFields({ rect, autoFocus, onChange }: { rect: Rect; autoFocus: boolean; onChange: (rect: Rect) => void }) {
  const baseId = useId();
  const { t } = useText();
  const update = (key: "x" | "y" | "w" | "h", percent: number) => {
    if (!Number.isFinite(percent)) return;
    const value = Math.min(100, Math.max(key === "w" || key === "h" ? 1 : 0, Math.round(percent))) / 100;
    const next = { ...rect, [key]: value };
    // Moving keeps the size; growing stops at the image edge.
    if (key === "x") next.x = Math.min(value, 1 - next.w);
    if (key === "y") next.y = Math.min(value, 1 - next.h);
    if (key === "w") next.w = Math.min(value, 1 - next.x);
    if (key === "h") next.h = Math.min(value, 1 - next.y);
    onChange(next);
  };
  return (
    <fieldset className="grid grid-cols-4 gap-1.5">
      <legend className="mb-1 text-xs font-medium text-foreground">{t.regionLegend}</legend>
      {REGION_FIELDS.map((field, index) => (
        <div key={field.key} className="min-w-0">
          <label htmlFor={`${baseId}-${field.key}`} className="block text-xs text-muted-foreground">{t[field.label]}</label>
          <input
            id={`${baseId}-${field.key}`}
            type="number"
            inputMode="numeric"
            min={field.key === "w" || field.key === "h" ? 1 : 0}
            max={100}
            step={1}
            autoFocus={autoFocus && index === 0}
            value={Math.round(rect[field.key] * 100)}
            onChange={(event) => update(field.key, event.currentTarget.valueAsNumber)}
            className={`${inputClass} px-1.5 tabular-nums`}
          />
        </div>
      ))}
    </fieldset>
  );
}

function CommentItem({ annotation, where, active, editable, rpc, onSelect, onChanged, announce }: {
  annotation: Annotation; where: string; active: boolean; editable: boolean; rpc: ProofRpc;
  onSelect: () => void; onChanged: () => void; announce: (notice: Notice) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(annotation.body);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const { locale, t } = useText();
  useEffect(() => setBody(annotation.body), [annotation.body]);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      setEditing(false);
      announce({ tone: "success", text: done });
      onChanged();
    } catch (error) {
      announce({ tone: "error", text: errorMessage(error, locale) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`rounded-md border px-2.5 py-2 ${active ? "border-foreground" : "border-border"}`}>
      <div className="flex items-start gap-2">
        <button type="button" onClick={onSelect} aria-label={t.showComment(annotation.number, where)}
          className={`mt-0.5 shrink-0 rounded-sm px-1.5 text-xs font-semibold leading-5 text-white ${focusRing}`} style={{ background: MARK_COLOR }}>
          {annotation.number}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground" title={where}>{where}</p>
          {editing ? (
            <form className="mt-1 space-y-1.5" onSubmit={(event) => { event.preventDefault(); void run(() => rpc.call("proofs_annotation_update", { id: annotation.id, body }), t.commentChanged(annotation.number)); }}>
              <label htmlFor={fieldId} className="sr-only">{t.editComment(annotation.number)}</label>
              <textarea id={fieldId} autoFocus rows={3} value={body} maxLength={LIMITS.commentChars} onChange={(event) => setBody(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Escape") { setEditing(false); setBody(annotation.body); } }} className={inputClass} />
              <div className="flex gap-2">
                <button type="submit" className={buttonClass.primary} disabled={busy || !body.trim()}>{t.save}</button>
                <button type="button" className={buttonClass.ghost} onClick={() => { setEditing(false); setBody(annotation.body); }}>{t.cancel}</button>
              </div>
            </form>
          ) : (
            <p className="mt-0.5 whitespace-pre-line break-words text-sm text-foreground">{annotation.body}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {annotation.sent ? <span>{t.sentInRound(annotation.round)}</span>
              : annotation.delivery === "no_recipient" ? <span>{t.decidedNoRecipient}</span>
                : annotation.locked ? <span>{t.decidedUndelivered}</span>
                  : <span>{t.notSent}</span>}
            {editable && !editing ? (
              <>
                <button type="button" className={buttonClass.link} onClick={() => setEditing(true)} aria-label={t.editComment(annotation.number)}>{t.edit}</button>
                <button type="button" className={buttonClass.link} disabled={busy} aria-label={t.deleteComment(annotation.number)}
                  onClick={() => void run(() => rpc.call("proofs_annotation_delete", { id: annotation.id }), t.commentDeleted(annotation.number))}>{t.delete}</button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/** What a stored decision still owes: an undelivered thread message or a GitHub status that could not be posted. */
function DeliveryNotice({ set, deliveries, postCommitStatus, rpc, announce, onChanged }: {
  set: ProofSet; deliveries: Delivery[]; postCommitStatus: boolean; rpc: ProofRpc; announce: (notice: Notice) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { locale, t } = useText();
  const failed = deliveries.filter((delivery) => delivery.status === "failed");
  const statusError = postCommitStatus && !set.stale && set.githubStatus?.error ? set.githubStatus.error : null;
  if (failed.length === 0 && !statusError) return null;
  const retry = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("proofs_retry", { setId: set.id });
      announce(result.warnings.length
        ? { tone: "error", text: t.retryFailed(result.warnings.join("\n")) }
        : { tone: "success", text: t.retryDone });
      onChanged();
    } catch (error) {
      announce({ tone: "error", text: errorMessage(error, locale) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section role="alert" aria-label={t.pendingDelivery} className="space-y-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      {failed.map((delivery) => (
        <p key={delivery.id} className="break-words text-foreground">
          <span className="font-medium">{delivery.kind === "approval" ? t.approvalNotDelivered : t.sendBackNotDelivered}</span>{" "}
          <span className="text-muted-foreground">{delivery.error}</span>
        </p>
      ))}
      {statusError ? (
        <p className="break-words text-foreground">
          <span className="font-medium">{t.statusNotPosted(set.githubStatus?.wanted ?? "")}</span>{" "}
          <span className="text-muted-foreground">{statusError}</span>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t.decisionSaved}</p>
      <button type="button" className={buttonClass.outline} disabled={busy} onClick={() => void retry()}>{busy ? t.delivering : t.deliverNow}</button>
    </section>
  );
}

function Decision({ set, assets, annotations, editable, postCommitStatus, rpc, announce, onChanged }: {
  set: ProofSet; assets: Asset[]; annotations: Annotation[]; editable: boolean; postCommitStatus: boolean; rpc: ProofRpc;
  announce: (notice: Notice) => void; onChanged: () => void;
}) {
  const open = annotations.filter((annotation) => !annotation.locked);
  const [sendOpen, setSendOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const noteId = useId();
  const { locale, t } = useText();
  if (!editable) return null;

  const sendBack = async () => {
    setError(null);
    try {
      setBusy(t.renderingMarks);
      const renders = await renderAnnotations(assets, open);
      setBusy(t.sending);
      const renderIds: string[] = [];
      for (const dataBase64 of renders) renderIds.push((await rpc.call("proofs_stage_render", { setId: set.id, dataBase64 })).renderId);
      const result = await rpc.call("proofs_send_back", { setId: set.id, revision: set.revision, renderIds });
      setSendOpen(false);
      const delivered = !result.warnings.some((warning) => warning.includes("not delivered"));
      announce(withWarnings(t.sentBack(open.length, delivered, renders.length), result.warnings, locale));
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, locale));
      // A refusal can come from a change made elsewhere; show the current state behind the dialog.
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  const approve = async () => {
    setError(null);
    setBusy(t.checkingHeadForApproval);
    try {
      const result = await rpc.call("proofs_approve", { setId: set.id, revision: set.revision, note });
      setApproveOpen(false);
      announce(withWarnings(t.approvedFor(shortSha(set.headSha)), result.warnings, locale));
      onChanged();
    } catch (cause) {
      // A moved head makes this set read-only and removes the dialog on reload, so the reason goes to the notice.
      setApproveOpen(false);
      announce({ tone: "error", text: t.notApproved(errorMessage(cause, locale)) });
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  const errorLine = error ? <p role="alert" className="mt-3 text-sm text-destructive-text">{error}</p> : null;

  return (
    <section aria-label={t.decision} className="space-y-2 rounded-lg border border-border bg-card p-3">
      {!set.threadId ? (
        <p className="text-xs text-muted-foreground">{t.noThreadBefore} <code className="font-mono">--thread</code>{t.noThreadAfter}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Dialog
          open={sendOpen}
          onOpenChange={(next) => { if (!busy) { setSendOpen(next); setError(null); } }}
          trigger={
            <button type="button" className={buttonClass.outline} disabled={open.length === 0 || !set.threadId}>
              {t.sendBack}{open.length ? ` (${open.length})` : ""}
            </button>
          }
          title={t.sendBackTitle}
          description={t.sendBackDescription(open.length)}
        >
          <ol className="max-h-48 space-y-1 overflow-y-auto text-sm">
            {open.map((annotation) => (
              <li key={annotation.id} className="flex gap-2">
                <span className="shrink-0 rounded-sm px-1 text-xs font-semibold leading-5 text-white" style={{ background: MARK_COLOR }}>{annotation.number}</span>
                <span className="min-w-0 break-words">{annotation.body}</span>
              </li>
            ))}
          </ol>
          {postCommitStatus ? <p className="mt-3 text-xs text-muted-foreground">{t.commitStatusBefore} <code className="font-mono">visual-proof</code>{t.commitStatusAfter("failure")}</p> : null}
          {errorLine}
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild><button type="button" className={buttonClass.ghost} disabled={busy !== null}>{t.cancel}</button></DialogClose>
            <button type="button" className={buttonClass.destructive} disabled={busy !== null} onClick={() => void sendBack()}>{busy ?? t.sendBack}</button>
          </div>
        </Dialog>
        <Dialog
          open={approveOpen}
          onOpenChange={(next) => { if (!busy) { setApproveOpen(next); setError(null); } }}
          trigger={<button type="button" className={buttonClass.primary} disabled={assets.length === 0}>{t.approve}</button>}
          title={t.approveTitle(shortSha(set.headSha))}
          description={t.approveDescription}
        >
          {open.length ? (
            <p className="mb-3 rounded-md border border-attention bg-attention/15 px-2.5 py-1.5 text-sm text-foreground">
              {t.unsentAsRemarks(open.length)}
            </p>
          ) : null}
          <label htmlFor={noteId} className="block text-sm font-medium text-foreground">{t.noteOptional}</label>
          <textarea id={noteId} rows={2} value={note} maxLength={LIMITS.commentChars} onChange={(event) => setNote(event.currentTarget.value)} className={`${inputClass} mt-1`} />
          {postCommitStatus ? <p className="mt-2 text-xs text-muted-foreground">{t.commitStatusBefore} <code className="font-mono">visual-proof</code>{t.commitStatusAfter("success")}</p> : null}
          {errorLine}
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild><button type="button" className={buttonClass.ghost} disabled={busy !== null}>{t.cancel}</button></DialogClose>
            <button type="button" className={buttonClass.primary} disabled={busy !== null} onClick={() => void approve()}>{busy ?? t.approve}</button>
          </div>
        </Dialog>
      </div>
    </section>
  );
}

function StorageLine({ set, assets, rpc, announce, onChanged }: {
  set: ProofSet; assets: Asset[]; rpc: ProofRpc; announce: (notice: Notice) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const i18n = useText();
  const { locale, t } = i18n;
  const deletable = (set.stale || set.status === "approved") && assets.some((asset) => !asset.expired);
  const remove = async () => {
    setBusy(true);
    try {
      await rpc.call("proofs_delete_media", { setId: set.id });
      setOpen(false);
      announce({ tone: "success", text: t.mediaRemoved });
      onChanged();
    } catch (error) {
      announce({ tone: "error", text: errorMessage(error, locale) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        {t.storedInBb(formatBytes(set.bytes, locale))}
        {` · ${mediaFate(set, assets, Date.now(), i18n) ?? t.keptWhileOpen}`}
      </span>
      {deletable ? (
        <Dialog open={open} onOpenChange={setOpen}
          trigger={<button type="button" className={buttonClass.link}>{t.deleteMediaNow}</button>}
          title={t.deleteMediaTitle}
          description={t.deleteMediaDescription}>
          <div className="flex justify-end gap-2">
            <DialogClose asChild><button type="button" className={buttonClass.ghost}>{t.cancel}</button></DialogClose>
            <button type="button" className={buttonClass.destructive} disabled={busy} onClick={() => void remove()}>{t.delete}</button>
          </div>
        </Dialog>
      ) : null}
    </p>
  );
}
