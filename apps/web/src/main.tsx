import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NearProvider } from "near-connect-hooks";
import App from "./App";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NearProvider config={{ network: "testnet", autoConnect: false }}>
      <App />
    </NearProvider>
  </StrictMode>
);
