import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

/**
 * Phase 0 viewer shell.
 *
 * The real read-only board will be implemented in the React UI phase. For now this component
 * proves the Vite workspace builds and reserves the app entrypoint without introducing write
 * controls or data-fetching behavior ahead of the HTTP/WS API phase.
 */
function App() {
  return (
    // The shell uses a single semantic main region so later UI work has a clear accessible root.
    <main className="app-shell">
      <h1>File Kanban Viewer</h1>
      <p>Read-only project board scaffold.</p>
    </main>
  );
}

// Vite serves `index.html`, which owns the root element that React hydrates into.
const rootElement = document.getElementById("root");

if (!rootElement) {
  // Failing fast makes an HTML/template mismatch obvious during local development and CI builds.
  throw new Error("Root element not found");
}

// StrictMode surfaces unsafe React patterns early while the viewer is still a small scaffold.
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
