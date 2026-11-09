import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Browser CORS bypass for Tidepool dry quotes (testnet Intents sandbox).
      "/tidepool": {
        target: "https://www.usetidepool.tech",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tidepool/, ""),
      },
      "/near-rpc": {
        target: "https://rpc.testnet.near.org",
        changeOrigin: true,
        rewrite: () => "/",
      },
    },
  },
});
