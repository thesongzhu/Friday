import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxyTarget = process.env.FRIDAY_UI_API_PROXY_TARGET ?? "http://127.0.0.1:3141";

function hasPackageSegment(id: string, packageName: string): boolean {
  const normalized = id.replaceAll("\\", "/");
  return normalized.includes(`/node_modules/${packageName}/`);
}

function resolveManualChunk(id: string): string | undefined {
  if (id.includes("/packages/friday-operator-client/")) {
    return "operator-client";
  }

  if (!id.includes("node_modules")) {
    return undefined;
  }

  if (hasPackageSegment(id, "react-router") || hasPackageSegment(id, "react-router-dom")) {
    return "router-vendor";
  }
  if (hasPackageSegment(id, "@tanstack/react-query") || hasPackageSegment(id, "@tanstack/query-core")) {
    return "query-vendor";
  }
  if (
    hasPackageSegment(id, "react") ||
    hasPackageSegment(id, "react-dom") ||
    hasPackageSegment(id, "scheduler")
  ) {
    return "react-vendor";
  }
  if (hasPackageSegment(id, "@xyflow/system")) {
    return "workflow-flow-system-vendor";
  }
  if (hasPackageSegment(id, "@xyflow/react")) {
    return "workflow-flow-vendor";
  }
  if (hasPackageSegment(id, "dagre") || hasPackageSegment(id, "graphlib")) {
    return "workflow-layout-vendor";
  }
  if (
    hasPackageSegment(id, "d3-selection") ||
    hasPackageSegment(id, "d3-transition") ||
    hasPackageSegment(id, "d3-interpolate") ||
    hasPackageSegment(id, "d3-drag") ||
    hasPackageSegment(id, "d3-zoom") ||
    hasPackageSegment(id, "d3-color") ||
    hasPackageSegment(id, "d3-timer") ||
    hasPackageSegment(id, "d3-dispatch") ||
    hasPackageSegment(id, "d3-ease")
  ) {
    return "workflow-d3-vendor";
  }
  if (
    hasPackageSegment(id, "zustand") ||
    hasPackageSegment(id, "use-sync-external-store") ||
    hasPackageSegment(id, "classcat") ||
    hasPackageSegment(id, "lodash")
  ) {
    return "workflow-state-vendor";
  }
  if (hasPackageSegment(id, "@simplewebauthn/browser")) {
    return "auth-vendor";
  }
  if (hasPackageSegment(id, "lucide-react")) {
    return "icons-vendor";
  }
  if (hasPackageSegment(id, "sonner") || hasPackageSegment(id, "clsx") || hasPackageSegment(id, "tailwind-merge")) {
    return "ui-vendor";
  }
  if (hasPackageSegment(id, "cron-parser") || hasPackageSegment(id, "luxon")) {
    return "time-vendor";
  }

  return "vendor";
}

export default defineConfig({
  root: resolve(__dirname),
  appType: "spa",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@friday-operator-client": resolve(
        __dirname,
        "../packages/friday-operator-client/src/index.ts",
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": {
        target: apiProxyTarget,
        changeOrigin: false,
        secure: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "../dist/ui"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    assetsDir: "assets",
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return resolveManualChunk(id);
        },
      },
    },
  },
});
