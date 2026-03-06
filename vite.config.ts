import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
const defaultPort = 1420;

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return port;
}

const devServerPort = parsePort(process.env.VITE_PORT) ?? defaultPort;
const hmrPort = parsePort(process.env.VITE_HMR_PORT) ?? devServerPort + 1;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: devServerPort,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: hmrPort } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
