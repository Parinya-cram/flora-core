// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-thai/wght.css";
import "./index.css";
import { ThemeProvider } from "./context/ThemeContext"; // Import provider
import { LanguageProvider } from "./context/LanguageContext";
import { installAuthenticatedFetch } from "./api/authenticatedFetch";
import { getSurfaceInfo } from "./edition/config";
import floraAppIcon from "./assets/logos/floraicon.png";
import canopyAppIcon from "./assets/logos/canopyicon.png";

installAuthenticatedFetch();

const surface = getSurfaceInfo();
const appIcon = surface.code === "canopy" ? canopyAppIcon : floraAppIcon;
document.title = surface.productName;
document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(link => {
  link.href = appIcon;
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </ThemeProvider>
  </React.StrictMode>
);
