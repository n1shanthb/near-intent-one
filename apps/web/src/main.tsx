import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NearProvider } from "near-connect-hooks";
import App from "./App";
import "./styles/landing.css";
import "./styles/axis.css";
import "./styles/workspace-theme.css";
import "./styles/nio-overrides.css";
/* Keep legacy component styles for embedded Portfolio/Activity/Security panels */
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NearProvider config={{ network: "testnet", autoConnect: false }}>
      <App />
    </NearProvider>
  </StrictMode>
);
