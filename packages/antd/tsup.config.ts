import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  banner: { js: '"use client";' },
  external: ["react", "react-dom", "antd", "@datatablex/core", "@datatablex/react"],
});
