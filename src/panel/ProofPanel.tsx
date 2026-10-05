import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH } from "../contract.js";
import { DetailView } from "./DetailView.js";
import { useMinuteClock, useProofRpc, useProofSignals } from "./hooks.js";
import { useText } from "./i18n.js";
import { ListView } from "./ListView.js";
import { detailSubPath, parseSubPath, type Notice } from "./model.js";
import { NoticeBar } from "./ui.js";

export function ProofPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const route = parseSubPath(subPath);
  const refreshKey = useProofSignals();
  const now = useMinuteClock();
  const { locale } = useText();
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // The acted-on control often disappears (sent comments, approved set), so focus moves to the notice.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const routeKey = route.kind === "list" ? "list" : `${route.repository}#${route.number}`;
  useEffect(() => setNotice(null), [routeKey]);

  const openDetail = useCallback((repository: string, number: number, setId?: string) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: detailSubPath(repository, number, setId) }), [navigate]);
  const openList = useCallback(() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" }), [navigate]);
  const shared = { refreshKey, now, announce: setNotice };

  return (
    <div lang={locale} className="h-full overflow-y-auto p-3 wrap-anywhere sm:p-4 md:p-5">
      <div className={`mx-auto w-full space-y-4 ${route.kind === "list" ? "max-w-4xl" : "max-w-6xl"}`}>
        <NoticeBar notice={notice} onDismiss={() => setNotice(null)} focusRef={noticeRef} />
        {route.kind === "list"
          ? <ListView {...shared} onOpen={openDetail} />
          : (
            <DetailView
              {...shared}
              key={routeKey}
              repository={route.repository}
              number={route.number}
              setId={route.setId}
              onBack={openList}
              onSelectSet={(setId) => openDetail(route.repository, route.number, setId)}
              onOpenThread={(threadId) => navigate.toThread(threadId)}
              onOpenUrl={(url) => navigate.openUrl(url)}
            />
          )}
      </div>
    </div>
  );
}

/** Sidebar row accessory: proofs waiting for review on their current head. */
export function PendingBadge() {
  const rpc = useProofRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [count, setCount] = useState(0);
  const refreshKey = useProofSignals(setCount);
  const { t } = useText();
  useEffect(() => {
    let cancelled = false;
    rpcRef.current.call("proofs_pending_count", null)
      .then((result) => { if (!cancelled) setCount(result.count); })
      // The panel reports load errors; the badge keeps its last count.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey]);
  if (count <= 0) return null;
  return (
    <span title={t.pendingTitle} className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold tabular-nums text-primary-foreground">
      {count > 99 ? "99+" : count}
      <span className="sr-only">{t.pendingSr}</span>
    </span>
  );
}
