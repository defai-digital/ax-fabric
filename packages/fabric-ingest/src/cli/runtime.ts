import { join } from "node:path";
import { homedir } from "node:os";

import { AkiDB } from "@ax-fabric/akidb";

import { MemoryStore } from "../memory/index.js";
import { SemanticStore } from "../semantic/index.js";
import { loadConfig, resolveConfigPath, resolveDataRoot, type FabricConfig } from "./config-loader.js";

export interface FabricRuntimePaths {
  dataRoot: string;
  akidbRoot: string;
  registryDbPath: string;
  semanticDbPath: string;
  memoryStorePath: string;
}

export interface FabricRuntime {
  configPath: string;
  config: FabricConfig;
  paths: FabricRuntimePaths;
  collections: {
    raw: string;
    semantic: string;
  };
}

export function loadFabricRuntime(configPath = resolveConfigPath()): FabricRuntime {
  const config = loadConfig(configPath);
  const dataRoot = resolveDataRoot(config);
  const rawCollectionId = config.akidb.collection;

  return {
    configPath,
    config,
    paths: {
      dataRoot,
      akidbRoot: expandTilde(config.akidb.root),
      registryDbPath: join(dataRoot, "registry.db"),
      semanticDbPath: join(dataRoot, "semantic.db"),
      memoryStorePath: join(dataRoot, "memory.json"),
    },
    collections: {
      raw: rawCollectionId,
      semantic: `${rawCollectionId}${config.retrieval.semantic_collection_suffix}`,
    },
  };
}

export function openRuntimeAkiDb(runtime: FabricRuntime): AkiDB {
  return new AkiDB({ storagePath: runtime.paths.akidbRoot });
}

export function openRuntimeSemanticStore(runtime: FabricRuntime, overridePath?: string): SemanticStore {
  return new SemanticStore(overridePath ? expandTilde(overridePath) : runtime.paths.semanticDbPath);
}

export function openRuntimeMemoryStore(runtime: FabricRuntime): MemoryStore {
  return new MemoryStore(runtime.paths.memoryStorePath);
}

export function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
