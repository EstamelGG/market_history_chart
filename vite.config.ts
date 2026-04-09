import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  /** 构建产物使用相对路径，便于部署在子目录或任意 base URL */
  base: "./",
  plugins: [react()],
  build: {
    outDir: "docs",
  },
});
