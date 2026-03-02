import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { setLiquidGlassEffect } from "tauri-plugin-liquid-glass-api";
import App from "./App";
import "./globals.css";

const isMacOs = /Mac/.test(navigator.platform);
const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const applySystemColorScheme = (prefersDark: boolean) => {
  document.documentElement.classList.toggle("dark", prefersDark);
};

applySystemColorScheme(colorSchemeQuery.matches);
colorSchemeQuery.addEventListener("change", (event) => {
  applySystemColorScheme(event.matches);
});

if (isTauri() && isMacOs) {
  document.documentElement.classList.add("tauri-glass");
  document.body.classList.add("tauri-glass");

  setLiquidGlassEffect({}).catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to enable liquid glass effect:", error);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
