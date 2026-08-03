import React from "react";
import { createRoot } from "react-dom/client";
import { WriterApp } from "../../app/writer-app";
import "../../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WriterApp />
  </React.StrictMode>,
);
