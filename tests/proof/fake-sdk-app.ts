// Browser stand-in for "@get-bb/plugin-sdk/app" in the screenshot harness only.
// RPC calls go over HTTP to the real server on the SDK fake host (see vite.config.ts);
// realtime signals are polled from that host's publish log.
import { useEffect, useMemo, useRef } from "react";

type Registration = { id: string; component: unknown; experimental_sidebarAccessory?: unknown };
const navPanels: Registration[] = [];

export function definePluginApp(setup: (app: { slots: { navPanel(registration: Registration): void } }) => void) {
  setup({ slots: { navPanel: (registration) => navPanels.push(registration) } });
  return { navPanels };
}

// ?rpc=hang keeps the first list/detail load pending; ?rpc=fail-once fails it once; ?fail=<method> fails that method.
const params = new URLSearchParams(location.search);
const rpcMode = params.get("rpc");
const failMethod = params.get("fail");
let loads = 0;

async function call(method: string, input: unknown): Promise<unknown> {
  if (method === "proofs_list" || method === "proofs_detail") {
    loads += 1;
    if (rpcMode === "hang") return new Promise(() => {});
    if (rpcMode === "fail-once" && loads === 1) throw new Error("Server unreachable (fetch failed)");
  }
  if (method === failMethod) throw new Error("Server unreachable (502 Bad Gateway)");
  const response = await fetch(`/__proof/rpc/${method}`, { method: "POST", body: JSON.stringify(input ?? null) });
  const body = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error);
  return body.result;
}

export function useRpc() {
  return useMemo(() => ({ call }), []);
}

const listeners = new Set<(channel: string, payload: unknown) => void>();
let cursor = -1;
async function poll() {
  const response = await fetch(`/__proof/signals?since=${cursor}`);
  const body = await response.json() as { next: number; signals: Array<{ channel: string; payload: unknown }> };
  if (cursor >= 0) for (const signal of body.signals) for (const listener of listeners) listener(signal.channel, signal.payload);
  cursor = body.next;
}
// ?realtime=off keeps the page on what it loaded, so a change made behind its back cannot reach it first.
if (params.get("realtime") !== "off") {
  setInterval(() => void poll(), 250);
  void poll();
}

export function useRealtime(channel: string, handler: (payload: unknown) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = (signalChannel: string, payload: unknown) => {
      if (signalChannel === channel) handlerRef.current(payload);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [channel]);
}

// ?lang=en|de|auto stands in for the plugin's language setting; without it the panel follows the browser language.
const language = params.get("lang");
export function useSettings() {
  return { values: language ? { language } : undefined, isLoading: false };
}

export function useRealtimeConnectionState() {
  return "connected" as const;
}

export function useBbNavigate() {
  return useMemo(() => ({
    toThread: (threadId: string) => { document.title = `navigate:${threadId}`; },
    openUrl: (url: string) => { document.title = `open:${url}`; },
    toPluginPanel: (_path: string, options?: { subPath?: string }) => {
      window.dispatchEvent(new CustomEvent("proof-navigate", { detail: options?.subPath ?? "" }));
    },
  }), []);
}

export type PluginNavPanelProps = { subPath: string };
