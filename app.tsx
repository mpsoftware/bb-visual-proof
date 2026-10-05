// Visual proof: PR screenshots and screencasts per head SHA, reviewed inside BB.
// The nav panel lists proofs; its sub-path `<owner>/<repo>/<number>` opens one PR.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PendingBadge, ProofPanel } from "./src/panel/ProofPanel.js";
import { PANEL_PATH } from "./src/contract.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "visual-proof",
    title: "Visual proof",
    icon: "Eye",
    path: PANEL_PATH,
    component: ProofPanel,
    experimental_sidebarAccessory: PendingBadge,
  });
});
