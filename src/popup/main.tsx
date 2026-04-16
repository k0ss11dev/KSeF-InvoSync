// SPDX-License-Identifier: GPL-3.0-or-later
import "./popup.css";
import { createRoot } from "react-dom/client";
import { initLocale } from "../shared/i18n";
import { App } from "./App";
import { MuiProvider } from "../theme/MuiProvider";

// Suppress MUI v9 internal warning: Stack renders a Grid internally which
// leaks system props (justifyContent, flexWrap) to the DOM. This is an
// upstream issue — our code already puts these in sx, not as direct props.
const origWarn = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("does not recognize the `%s` prop on a DOM element")) return;
  origWarn.apply(console, args);
};

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

initLocale().then(() => {
  createRoot(root).render(
    <MuiProvider>
      <App />
    </MuiProvider>,
  );
});
