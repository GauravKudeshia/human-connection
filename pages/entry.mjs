import { createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "../app/connection-app.jsx";
import { makeBrowserRequest } from "./transport.mjs";
let store;
try {
  store = window.sessionStorage;
  store.setItem("hc-write-check", "1");
  store.removeItem("hc-write-check");
} catch {
  store = null;
}
const request = makeBrowserRequest(
  store,
  `human-connection-v12:${location.pathname.replace(/index\.html$/, "")}`,
);
createRoot(document.getElementById("root")).render(
  createElement(App, { request }),
);
