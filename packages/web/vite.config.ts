import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.VERSION || "0.0.0-dev"),
  },
  plugins: [react(), tailwindcss()],
  root: "src/client",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/client"),
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
