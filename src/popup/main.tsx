// SPDX-License-Identifier: GPL-3.0-or-later
import "./popup.css";
import { createRoot } from "react-dom/client";
import { initLocale } from "../shared/i18n";
import { App } from "./App";
import { MuiProvider } from "../theme/MuiProvider";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

initLocale().then(() => {
  createRoot(root).render(
    <MuiProvider>
      <App />
    </MuiProvider>,
  );
});
