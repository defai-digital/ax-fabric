import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    tsconfig: "tsconfig.build.json",
    dts: true,
    clean: true,
    sourcemap: true,
    external: ["@ax-fabric/akidb-native"],
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    tsconfig: "tsconfig.build.json",
    dts: false,
    sourcemap: true,
    external: ["@ax-fabric/akidb-native"],
  },
]);
