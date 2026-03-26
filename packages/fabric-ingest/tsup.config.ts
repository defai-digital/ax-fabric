import { defineConfig } from "tsup";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixNodeImports = {
  name: "fix-node-sqlite",
  buildEnd() {
    for (const file of ["dist/cli.js", "dist/index.js"]) {
      const path = join(import.meta.dirname, file);
      try {
        const content = readFileSync(path, "utf-8");
        writeFileSync(path, content.replace(/from "sqlite"/g, 'from "node:sqlite"'));
      } catch {}
    }
  },
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    tsconfig: "tsconfig.build.json",
    dts: true,
    clean: true,
    sourcemap: true,
    external: ["@ax-fabric/akidb-native", "node:sqlite"],
    plugins: [fixNodeImports],
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    tsconfig: "tsconfig.build.json",
    dts: false,
    sourcemap: true,
    external: ["@ax-fabric/akidb-native", "node:sqlite"],
    plugins: [fixNodeImports],
  },
]);
