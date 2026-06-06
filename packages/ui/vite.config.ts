import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite configuration for the read-only React viewer package.
 *
 * The UI stays isolated from core and server internals; this config only enables React compilation
 * for the browser app that will later consume the HTTP/WebSocket viewer API.
 */
export default defineConfig({
  // The React plugin provides JSX transformation and development refresh for the viewer scaffold.
  plugins: [react()]
});
