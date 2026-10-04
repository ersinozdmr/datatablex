import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessLogsScreen } from "./screens/AccessLogsScreen.js";

const root = document.getElementById("root");
if (!root) throw new Error("[example] #root not found");

createRoot(root).render(
  <StrictMode>
    <AccessLogsScreen />
  </StrictMode>,
);
