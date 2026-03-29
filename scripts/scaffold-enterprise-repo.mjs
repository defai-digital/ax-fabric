import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function usage() {
  console.error(
    "Usage: node scripts/scaffold-enterprise-repo.mjs [target-dir] [--scope @your-scope] [--repo-name name]",
  );
}

function parseArgs(argv) {
  let targetDir = "../ax-fabric-enterprise";
  let scope = "@your-org";
  let repoName = "ax-fabric-enterprise";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (!arg.startsWith("--") && targetDir === "../ax-fabric-enterprise") {
      targetDir = arg;
      continue;
    }

    if (arg === "--scope") {
      scope = argv[index + 1] ?? scope;
      index += 1;
      continue;
    }

    if (arg === "--repo-name") {
      repoName = argv[index + 1] ?? repoName;
      index += 1;
      continue;
    }

    usage();
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    repoName,
    scope,
    targetDir: path.resolve(repoRoot, targetDir),
  };
}

function assertTargetOutsidePublicRepo(targetDir) {
  const relative = path.relative(repoRoot, targetDir);
  const isInsideRepo = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (isInsideRepo) {
    throw new Error(
      `Target directory must be outside the public repository: ${targetDir}`,
    );
  }
}

function ensureTargetIsEmptyOrMissing(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const entries = readdirSync(targetDir);
  if (entries.length > 0) {
    throw new Error(`Target directory must be empty: ${targetDir}`);
  }
}

function writeFiles(targetDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const outputPath = path.join(targetDir, relativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, content);
  }
}

function filesFor({ repoName, scope }) {
  const runtimePkg = `${scope}/${repoName}-runtime`;
  const connectorsPkg = `${scope}/${repoName}-connectors`;
  const publicVersion = "3.2.x";

  return {
    ".gitignore": `node_modules
dist
coverage
.DS_Store
.env
.env.*
*.log
`,
    "README.md": `# ${repoName}

Private enterprise repository for AX Fabric.

This repository is for proprietary implementation that must not be committed to the public AX Fabric repository.

## Scope

- enterprise runtime orchestration
- proprietary connectors
- private deployment bundles
- customer-specific integrations

## Dependency Rule

- this repository may depend on released public AX Fabric packages
- the public AX Fabric repository must not depend on this repository

## First Steps

1. Configure the private package registry or container registry.
2. Replace placeholder package names under \`packages/\` with the real internal naming convention if needed.
3. Pin the public AX Fabric package versions that this private line supports.
4. Add CI secrets for private publish flows.
`,
    "LICENSE.md": `All Rights Reserved.

This repository contains proprietary implementation and is not part of the public AX Fabric open-source repository.
`,
    "package.json": `{
  "name": "${repoName}",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.22.0",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test --if-present",
    "clean": "pnpm -r clean --if-present"
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
`,
    "pnpm-workspace.yaml": `packages:
  - packages/*
`,
    "tsconfig.json": `{
  "files": [],
  "references": [
    { "path": "./packages/enterprise-runtime" },
    { "path": "./packages/enterprise-connectors" }
  ]
}
`,
    ".github/workflows/ci.yml": `name: CI

on:
  push:
    branches:
      - main
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.22.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
`,
    "docs/architecture.md": `# Architecture

This private repository extends AX Fabric through external boundaries rather than private in-process extension points.

Preferred integration boundaries:

- HTTP or gRPC services
- CLI or worker processes
- MCP tools and servers
- queue-driven asynchronous jobs

Avoid making the public AX Fabric repository depend on unpublished source from this repository.
`,
    "docs/compatibility-matrix.md": `# Compatibility Matrix

| Private line | Public AX Fabric line | Notes |
| --- | --- | --- |
| 1.0.x | 3.2.x | Initial private bootstrap line |
`,
    "docs/release-runbook.md": `# Release Runbook

1. Confirm the public AX Fabric version range in \`docs/compatibility-matrix.md\`.
2. Run \`pnpm install\`, \`pnpm build\`, \`pnpm typecheck\`, and \`pnpm test\`.
3. Publish private packages or private images through the approved internal registry.
4. Record the compatible public AX Fabric version range in the release notes.
`,
    "configs/environments/.gitkeep": "",
    "packages/enterprise-runtime/package.json": `{
  "name": "${runtimePkg}",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@ax-fabric/akidb": "${publicVersion}",
    "@ax-fabric/contracts": "${publicVersion}",
    "@ax-fabric/fabric-ingest": "${publicVersion}"
  }
}
`,
    "packages/enterprise-runtime/tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
`,
    "packages/enterprise-runtime/src/index.ts": `export interface EnterpriseRuntimeConfig {
  collectionId: string;
  deploymentTarget: string;
}

export function describeEnterpriseRuntime(config: EnterpriseRuntimeConfig): string {
  return \`enterprise-runtime:\${config.collectionId}:\${config.deploymentTarget}\`;
}
`,
    "packages/enterprise-connectors/package.json": `{
  "name": "${connectorsPkg}",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@ax-fabric/contracts": "${publicVersion}",
    "@ax-fabric/fabric-ingest": "${publicVersion}"
  }
}
`,
    "packages/enterprise-connectors/tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
`,
    "packages/enterprise-connectors/src/index.ts": `export interface ConnectorDescriptor {
  id: string;
  kind: string;
}

export function listBootstrapConnectors(): ConnectorDescriptor[] {
  return [
    {
      id: "replace-me",
      kind: "private-source",
    },
  ];
}
`,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertTargetOutsidePublicRepo(options.targetDir);
  ensureTargetIsEmptyOrMissing(options.targetDir);
  writeFiles(options.targetDir, filesFor(options));

  console.log(`Created private enterprise scaffold at ${options.targetDir}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
