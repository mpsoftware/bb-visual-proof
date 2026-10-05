import { useId, useState } from "react";
import type { Asset, SetSummary } from "../contract.js";
import { useLoader, useProofRpc, useThumbnailBackfill } from "./hooks.js";
import { useText } from "./i18n.js";
import { countsLabel, errorMessage, formatBytes, mediaUrl, shortSha, statusOf, thumbUrl, type Notice } from "./model.js";
import { Age, buttonClass, EmptyState, ErrorState, fieldClass, focusRing, LoadingState, StatusBadge } from "./ui.js";

type View = "open" | "done";

export function ListView({ refreshKey, now, onOpen }: {
  refreshKey: number;
  now: number;
  announce: (notice: Notice) => void;
  onOpen: (repository: string, number: number) => void;
}) {
  const rpc = useProofRpc();
  const { locale, t } = useText();
  const [view, setView] = useState<View>("open");
  const [repository, setRepository] = useState("");
  const filterId = useId();
  const { state, retry, refresh } = useLoader(
    () => rpc.call("proofs_list", { view, ...(repository ? { repository } : {}) }),
    [refreshKey, view, repository],
  );

  const tabs: Array<{ id: View; label: string; count?: number }> = [
    { id: "open", label: t.tabOpen, count: state.status === "ready" ? state.value.openCount : undefined },
    { id: "done", label: t.tabDone, count: state.status === "ready" ? state.value.doneCount : undefined },
  ];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">{t.listTitle}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t.listIntro}</p>
        </div>
        {state.status === "ready" && state.value.repositories.length > 1 ? (
          <div className="flex items-center gap-2">
            <label htmlFor={filterId} className="shrink-0 whitespace-nowrap text-sm font-medium text-foreground">{t.repository}</label>
            <select id={filterId} value={repository} onChange={(event) => setRepository(event.currentTarget.value)} className={`${fieldClass} min-w-0 max-w-64`}>
              <option value="">{t.allRepositories}</option>
              {state.value.repositories.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        ) : null}
      </header>

      <nav aria-label={t.views} className="flex flex-wrap gap-1.5">
        {tabs.map((tab) => {
          const active = tab.id === view;
          return (
            <button key={tab.id} type="button" aria-current={active ? "page" : undefined} onClick={() => setView(tab.id)}
              className={active ? buttonClass.primary : buttonClass.outline}>
              {tab.label}
              {tab.count !== undefined ? (
                <span className={`min-w-5 rounded-full px-1.5 text-xs tabular-nums ${active ? "bg-primary-foreground/20" : "bg-muted text-foreground"}`}>{tab.count}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {state.status === "loading" ? <LoadingState label={t.listLoading} /> : null}
      {state.status === "error" ? <ErrorState title={t.listError} message={errorMessage(state.message, locale)} onRetry={retry} /> : null}
      {state.status === "ready" ? (
        <>
          {state.refreshError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              <span className="text-destructive-text">{t.refreshFailed(errorMessage(state.refreshError, locale))}</span>
              <button type="button" className={buttonClass.link} onClick={refresh}>{t.retry}</button>
            </div>
          ) : null}
          {state.value.sets.length === 0 ? (
            view === "open" ? (
              <EmptyState title={t.emptyOpen}>
                <p>{t.emptyOpenBefore}</p>
                <code className="mt-2 inline-block rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">bb visual-proof add owner/repo#123 docs/proofs</code>
                <p className="mt-2">{t.emptyOpenAfter}</p>
              </EmptyState>
            ) : <EmptyState title={t.emptyDone} />
          ) : (
            <ul className="space-y-2.5" aria-label={view === "open" ? t.openList : t.doneList}>
              {state.value.sets.map((set) => (
                <li key={set.id}><SetCard set={set} now={now} onOpen={() => onOpen(set.repository, set.number)} /></li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {t.storage(formatBytes(state.value.usage.bytes, locale), formatBytes(state.value.usage.quotaBytes, locale))}
          </p>
        </>
      ) : null}
    </div>
  );
}

function SetCard({ set, now, onOpen }: { set: SetSummary; now: number; onOpen: () => void }) {
  const { t } = useText();
  const status = statusOf(set, t);
  useThumbnailBackfill(set.previews);
  const titleId = useId();
  return (
    <article aria-labelledby={titleId} className="relative rounded-lg border border-border bg-card px-4 py-3 shadow-sm transition-colors hover:bg-accent/40">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={status.tone} label={status.label} />
        <span className="text-xs text-muted-foreground">{set.repository} #{set.number}</span>
        <span className="font-mono text-xs text-muted-foreground">{t.head(shortSha(set.headSha))}</span>
        {set.round > 1 ? <span className="text-xs text-muted-foreground">{t.round(set.round)}</span> : null}
        <span className="ml-auto"><Age iso={set.updatedAt} now={now} /></span>
      </div>
      <h2 id={titleId} className="mt-1.5 text-sm font-medium leading-5 text-foreground">
        {/* The whole card is clickable through this button's overlay; it keeps one tab stop and a real name. */}
        <button type="button" onClick={onOpen} className={`text-left after:absolute after:inset-0 after:rounded-lg after:content-[''] ${focusRing}`}>
          {set.prTitle}
        </button>
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {countsLabel(set, t)}
        {set.openAnnotationCount ? t.unsentComments(set.openAnnotationCount) : ""}
        {set.stale && set.currentHeadSha && set.currentHeadSha !== set.headSha ? t.prMovedNoProof(shortSha(set.currentHeadSha)) : ""}
      </p>
      {set.previews.length ? (
        <div className="mt-2.5 flex gap-1.5 overflow-hidden" aria-hidden="true">
          {set.previews.map((asset) => <PreviewTile key={asset.id} asset={asset} />)}
          {set.imageCount + set.videoCount > set.previews.length ? (
            <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded border border-border bg-muted text-xs text-muted-foreground">
              +{set.imageCount + set.videoCount - set.previews.length}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function PreviewTile({ asset, size = "sm" }: { asset: Asset; size?: "sm" | "md" }) {
  const { t } = useText();
  const box = size === "sm" ? "h-14 w-20" : "h-16 w-24";
  const src = asset.hasThumbnail ? thumbUrl(asset.sha256) : asset.expired || asset.kind === "video" ? null : mediaUrl(asset.sha256);
  return (
    <div className={`relative ${box} shrink-0 overflow-hidden rounded border border-border bg-muted`}>
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover object-top" /> : null}
      {asset.kind === "video" ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">▶</span>
        </span>
      ) : null}
      {asset.expired ? <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 text-center text-[10px] text-white">{t.expired}</span> : null}
    </div>
  );
}
