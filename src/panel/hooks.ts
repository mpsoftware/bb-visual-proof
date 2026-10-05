import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server.js";
import type { Asset } from "../contract.js";
import { CHANGED_CHANNEL, isCounts } from "./model.js";
import { makeThumbnail } from "./render.js";

export type ProofRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export function useProofRpc(): ProofRpc {
  return useRpc<typeof rpcContract>();
}

/** Bumps a refresh key on every change signal and after a realtime reconnect, when missed signals are not replayed. */
export function useProofSignals(onCount?: (count: number) => void): number {
  const [refreshKey, setRefreshKey] = useState(0);
  useRealtime(CHANGED_CHANNEL, useCallback((payload: unknown) => {
    if (isCounts(payload)) onCount?.(payload.pendingCount);
    setRefreshKey((key) => key + 1);
  }, [onCount]));
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current === "reconnecting") setRefreshKey((key) => key + 1);
    previous.current = connection;
  }, [connection]);
  return refreshKey;
}

/** Keeps relative ages current while the panel stays open. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T; refreshError: string | null };

/**
 * Loads on mount and on every key change; a failed background reload keeps the last value on screen. Errors are kept
 * as they came, so the view translates them in the current language.
 */
export function useLoader<T>(load: () => Promise<T>, keys: readonly unknown[]) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const request = useRef(0);
  const reload = useCallback(async (foreground: boolean) => {
    const id = ++request.current;
    if (foreground) setState({ status: "loading" });
    try {
      const value = await loadRef.current();
      if (id === request.current) setState({ status: "ready", value, refreshError: null });
    } catch (error) {
      if (id !== request.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => current.status === "ready" && !foreground
        ? { ...current, refreshError: message }
        : { status: "error", message });
    }
  }, []);
  const first = useRef(true);
  useEffect(() => {
    void reload(first.current);
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, keys);
  return { state, retry: () => void reload(true), refresh: () => void reload(false) };
}

const attempted = new Set<string>();

/**
 * Thumbnails are kept after the media expires, for the audit trail. The panel creates each one the first time it
 * shows a file that has none yet; failures are silent and the file keeps its media preview.
 */
export function useThumbnailBackfill(assets: readonly Asset[]): void {
  const rpc = useProofRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const pending = assets.filter((asset) => !asset.hasThumbnail && !asset.expired && !attempted.has(asset.id));
  const key = pending.map((asset) => asset.id).join(",");
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void (async () => {
      for (const asset of pending) {
        if (cancelled) return;
        attempted.add(asset.id);
        try {
          const dataBase64 = await makeThumbnail(asset);
          await rpcRef.current.call("proofs_thumbnail_put", { assetId: asset.id, dataBase64 });
        } catch {
          // The media preview stays; the next app session tries again.
          continue;
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
