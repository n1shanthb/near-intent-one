import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NearProvider } from "near-connect-hooks";
import App from "./App";
/* Legacy component classes first; AXIS + nio-overrides win for contrast. */
import "./style.css";
import "./styles/landing.css";
import "./styles/axis.css";
import "./styles/workspace-theme.css";
import "./styles/nio-overrides.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NearProvider config={{ network: "testnet", autoConnect: false }}>
      <App />
    </NearProvider>
  </StrictMode>
);
