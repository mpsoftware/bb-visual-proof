// Plugin-owned controls in the BB look.
import type { ReactNode } from "react";
import type { Anchor } from "../contract.js";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useText } from "./i18n.js";
import { PLUGIN_ID, formatAge, formatDateTime, type Notice, type StatusTone } from "./model.js";

export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
const buttonBase = `inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const buttonClass = {
  primary: `${buttonBase} bg-primary text-primary-foreground hover:bg-primary/90`,
  outline: `${buttonBase} border border-border bg-background text-foreground hover:bg-accent`,
  destructive: `${buttonBase} bg-destructive text-white hover:bg-destructive/90`,
  ghost: `${buttonBase} text-muted-foreground hover:bg-accent hover:text-foreground`,
  link: `rounded-sm text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground ${focusRing}`,
};

export const fieldClass = `rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground ${focusRing}`;
export const inputClass = `w-full ${fieldClass}`;

const toneClass: Record<StatusTone | "neutral", string> = {
  neutral: "border-border bg-muted text-foreground",
  pending: "border-attention bg-attention/20 text-foreground",
  changes: "border-destructive/40 bg-destructive/10 text-destructive-text",
  approved: "border-success/50 bg-success/15 text-foreground",
  stale: "border-border bg-muted text-muted-foreground",
};

const toneGlyph: Record<StatusTone, string> = { pending: "●", changes: "↩", approved: "✓", stale: "⚠" };

export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${toneClass[tone]}`}>
      <span aria-hidden="true">{toneGlyph[tone]}</span>
      {label}
    </span>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${toneClass.neutral}`}>{children}</span>;
}

export function Age({ iso, now }: { iso: string; now: number }) {
  const i18n = useText();
  return <time dateTime={iso} title={formatDateTime(iso, i18n.locale)} className="text-xs text-muted-foreground">{formatAge(iso, now, i18n)}</time>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((row) => <div key={row} aria-hidden="true" className="h-28 animate-pulse rounded-lg border border-border bg-muted" />)}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  const { t } = useText();
  return (
    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-4">
      <p className="text-sm font-medium text-destructive-text">{title}</p>
      <p className="mt-1 break-words text-sm text-muted-foreground">{message}</p>
      <button type="button" className={`${buttonClass.outline} mt-3`} onClick={onRetry}>{t.retry}</button>
    </div>
  );
}

export function NoticeBar({ notice, onDismiss, focusRef }: { notice: Notice | null; onDismiss: () => void; focusRef: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useText();
  return (
    <div role="status" aria-live="polite">
      {notice ? (
        <div
          ref={focusRef}
          tabIndex={-1}
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${focusRing} ${
            notice.tone === "error" ? "border-destructive/40 bg-destructive/5 text-destructive-text"
              : notice.tone === "warning" ? "border-attention bg-attention/15 text-foreground"
                : "border-success/50 bg-success/10 text-foreground"
          }`}
        >
          <p className="min-w-0 flex-1 whitespace-pre-line break-words">{notice.text}</p>
          <button type="button" aria-label={t.dismissNotice} className={`${buttonClass.ghost} min-h-6 px-1.5 py-0`} onClick={onDismiss}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function portalScopeProps() {
  return { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", "data-bb-plugin": PLUGIN_ID };
}

/** Radix handles Escape, the focus trap, and returning focus to the trigger on close. */
export function Dialog({ open, onOpenChange, trigger, title, description, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay {...portalScopeProps()} className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          {...portalScopeProps()}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-background p-5 text-foreground shadow-lg wrap-anywhere"
        >
          <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
          <div className="mt-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const DialogClose = DialogPrimitive.Close;

/** Marker colour for annotation boxes, on screen and in the annotated copies sent to the implementer. */
export const MARK_COLOR = "#e11d48";

/** An annotation box over an image, as percentages of the drawn image, so it stays aligned at any size or zoom. */
export function BoxMark({ rect, label, active, draft }: { rect: Extract<Anchor, { kind: "rect" }>; label: string; active: boolean; draft?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{
        left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%`,
        border: `${active ? 3 : 2}px ${draft ? "dashed" : "solid"} ${MARK_COLOR}`,
        boxShadow: "0 0 0 1px #fff, inset 0 0 0 1px #fff",
        background: active ? "rgba(225, 29, 72, 0.08)" : undefined,
      }}
    >
      <span className="absolute -left-0.5 -top-5 rounded-sm px-1 text-xs font-semibold leading-5 text-white" style={{ background: MARK_COLOR }}>{label}</span>
    </div>
  );
}
