import type { Anchor, Annotation, Asset, ProofSet } from "../contract.js";
import type { I18n, Locale, Text } from "./i18n.js";

declare const __BB_PLUGIN_ID__: string | undefined;
export const PLUGIN_ID = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : "visual-proof";
export const CHANGED_CHANNEL = "visual-proof-changed";

export type Notice = { tone: "success" | "error" | "warning"; text: string };
export type Route = { kind: "list" } | { kind: "detail"; repository: string; number: number; setId?: string };

/** `<owner>/<repo>/<number>[/<setId>]` → a PR detail; anything else is the list. */
export function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 3 || !/^\d+$/.test(parts[2]!)) return { kind: "list" };
  return { kind: "detail", repository: `${parts[0]}/${parts[1]}`.toLowerCase(), number: Number(parts[2]), ...(parts[3] ? { setId: parts[3] } : {}) };
}

export function detailSubPath(repository: string, number: number, setId?: string): string {
  return [...repository.split("/"), String(number), ...(setId ? [setId] : [])].map(encodeURIComponent).join("/");
}

export const mediaUrl = (sha256: string) => `/api/v1/plugins/${PLUGIN_ID}/http/media?sha=${sha256}`;
export const thumbUrl = (sha256: string) => `/api/v1/plugins/${PLUGIN_ID}/http/thumb?sha=${sha256}`;

export const shortSha = (sha: string) => sha.slice(0, 7);

export type StatusTone = "pending" | "changes" | "approved" | "stale";
export function statusOf(set: Pick<ProofSet, "stale" | "status" | "staleReason">, t: Text): { tone: StatusTone; label: string } {
  if (set.stale) return { tone: "stale", label: set.staleReason === "head_moved" ? t.statusHeadMoved : t.statusStale };
  if (set.status === "approved") return { tone: "approved", label: t.statusApproved };
  if (set.status === "changes_requested") return { tone: "changes", label: t.statusChanges };
  return { tone: "pending", label: t.statusPending };
}

export function countsLabel(set: Pick<ProofSet, "imageCount" | "videoCount">, t: Text): string {
  const parts = [set.imageCount ? t.screenshots(set.imageCount) : null, set.videoCount ? t.screencasts(set.videoCount) : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : t.noFiles;
}

export function formatBytes(bytes: number, locale: Locale): string {
  const format = (value: number, digits: number) => value.toLocaleString(locale, { maximumFractionDigits: digits });
  if (bytes < 1024 * 1024) return `${format(bytes / 1024, 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${format(bytes / (1024 * 1024), 1)} MB`;
  return `${format(bytes / (1024 * 1024 * 1024), 1)} GB`;
}

export function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function anchorLabel(anchor: Anchor, t: Text): string {
  if (anchor.kind === "time") return t.anchorAt(formatTime(anchor.ms));
  if (anchor.kind === "rect") return anchor.w >= 0.999 && anchor.h >= 0.999 ? t.anchorWholeImage : t.anchorRegion;
  return t.anchorWholeSet;
}

export function formatAge(iso: string, now: number, { locale, t }: I18n): string {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const seconds = Math.min(0, Math.round((Date.parse(iso) - now) / 1000));
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  }
  return t.justNow;
}
export const formatDateTime = (iso: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
export const formatDate = (iso: string, locale: Locale) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

/** Known refusals from the server, in German; server texts are English, so other languages show them as they came. */
const KNOWN_ERRORS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/changed since you opened it/, () => "Der Nachweis hat sich seit dem Öffnen geändert (neue Dateien oder Kommentare). Bitte den aktuellen Stand prüfen und neu entscheiden."],
  [/The PR head moved to ([0-9a-f]{7})/, (match) => `Der PR steht inzwischen auf ${match[1]}; dieser Nachweis ist veraltet und wurde nicht freigegeben.`],
  [/The PR head could not be checked, so nothing was approved: (.*)/s, (match) => `Der PR-Head ließ sich nicht prüfen, deshalb wurde nichts freigegeben: ${match[1]}`],
  [/outdated head and is read-only/, () => "Dieser Nachweis gehört zu einem veralteten Head und ist schreibgeschützt."],
  [/approved and read-only/, () => "Dieser Nachweis ist freigegeben und schreibgeschützt."],
  [/A sent comment cannot be changed/, () => "Ein gesendeter Kommentar kann nicht mehr geändert werden."],
  [/already being sent/, () => "Für diesen Nachweis läuft bereits eine Entscheidung; bitte kurz warten."],
  [/^Message to the implementer thread not delivered \(retry in the panel\): (.*)/s, (match) => `Nachricht an den Implementierer-Thread nicht zugestellt: ${match[1]}`],
  [/^Commit status not posted \(will be retried\): (.*)/s, (match) => `GitHub-Status nicht gesetzt, BB versucht es erneut: ${match[1]}`],
  [/^PR comment not updated: (.*)/s, (match) => `PR-Kommentar nicht aktualisiert: ${match[1]}`],
];

export function errorMessage(error: unknown, locale: Locale): string {
  const message = error instanceof Error ? error.message : String(error);
  if (locale !== "de") return message;
  for (const [pattern, translate] of KNOWN_ERRORS) {
    const match = pattern.exec(message);
    if (match) return translate(match);
  }
  return message;
}

export function isCounts(value: unknown): value is { pendingCount: number } {
  return typeof value === "object" && value !== null && typeof (value as { pendingCount?: unknown }).pendingCount === "number";
}

/** Comments of one file in number order; set-level notes have no file. */
export function annotationsFor(annotations: readonly Annotation[], asset: Asset | null): Annotation[] {
  return annotations.filter((annotation) => annotation.assetId === (asset?.id ?? null));
}

export function assetLabel(asset: Asset): string {
  return asset.caption || asset.filename;
}
