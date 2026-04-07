import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// Remove password manager injected elements (e.g. LastPass icons).
// They re-inject after React renders, so a MutationObserver is needed.
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLElement && (
        node.hasAttribute("data-lastpass-root") ||
        node.hasAttribute("data-lastpass-icon-root")
      )) {
        node.remove();
      }
    }
  }
});
observer.observe(document.body, { childList: true, subtree: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
