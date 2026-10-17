import "./styles.css";
import "./pdfjs-annotations.css";
import { App } from "./app";

if (new URLSearchParams(location.search).has("mcp")) {
  // Started with --mcp: a hidden window that only runs the PDF tools.
  import("./mcp").then((m) => m.startMcp()).catch((e) => console.error(e));
} else {
  const app = new App();
  app.init().catch((e) => console.error(e));
  // Exposed for debugging and automated tests.
  (window as unknown as { laserPdf: App }).laserPdf = app;
}
