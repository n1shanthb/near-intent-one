import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { ledgerMigratePlugin } from "./vite-plugin-ledger-migrate.ts";

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["buffer"],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    react(),
    ledgerMigratePlugin(),
  ],
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer/",
    },
  },
  optimizeDeps: {
    include: ["buffer", "@ledgerhq/hw-transport-webhid", "@ledgerhq/hw-transport"],
  },
  server: {
    port: 5173,
    proxy: {
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
