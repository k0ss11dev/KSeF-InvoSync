// SPDX-License-Identifier: GPL-3.0-or-later
import "../options/options.css";
import { createRoot } from "react-dom/client";
import { initLocale } from "../shared/i18n";
import { Options } from "./Options";
import { MuiProvider } from "../theme/MuiProvider";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

initLocale().then(() => {
  createRoot(root).render(
    <MuiProvider>
      <Options />
    </MuiProvider>,
  );
});
