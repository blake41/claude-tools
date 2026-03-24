import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { router } from "./router";
import "./App"; // Attaches route components to the route tree
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NuqsAdapter>
      <RouterProvider router={router} />
    </NuqsAdapter>
  </React.StrictMode>
);
