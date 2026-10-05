// Mounts the plugin's registered nav panel and sidebar accessory in a minimal BB-like shell.
import { createElement, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "./bb-theme.css";
import "../../dist/app.css";
import definition from "../../app.js";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");

const { navPanels } = definition as unknown as { navPanels: Array<{ component: ComponentType<{ subPath: string }>; experimental_sidebarAccessory: ComponentType }> };
const [panel] = navPanels;

function Shell() {
  const [subPath, setSubPath] = useState(params.get("sub") ?? "");
  useEffect(() => {
    const onNavigate = (event: Event) => setSubPath((event as CustomEvent<string>).detail);
    window.addEventListener("proof-navigate", onNavigate);
    return () => window.removeEventListener("proof-navigate", onNavigate);
  }, []);
  return (
    <div className="shell" data-bb-plugin="visual-proof">
      <nav className="sidebar" aria-label="BB sidebar (mock)">
        <div className="sidebar-caption">BB sidebar (mock)</div>
        <div className="sidebar-row">New thread</div>
        <div className="sidebar-row">Tasks</div>
        <div className="sidebar-row active" data-testid="sidebar-proof">
          Visual proof
          <span className="accessory">{createElement(panel!.experimental_sidebarAccessory)}</span>
        </div>
        <div className="sidebar-row">Pull requests</div>
      </nav>
      <main className="page">
        <div className="titlebar">Visual proof</div>
        <div className="body">{createElement(panel!.component, { subPath })}</div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
