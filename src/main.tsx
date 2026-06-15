import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OJamlEditor } from "./components/OJamlEditor";
import "./styles.css";

createRoot(document.querySelector<HTMLDivElement>("#app")!).render(
  <StrictMode>
    <OJamlEditor />
  </StrictMode>,
);
