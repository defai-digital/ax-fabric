import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const forbiddenPatterns = [
  /^enterprise\//,
  /^private\//,
  /^commercial\//,
  /^ee\//,
  /^packages\/enterprise-/,
  /^packages\/.*-enterprise(?:\/|$)/,
];

const referenceCheckFilePatterns = [
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^packages\/.*\.(?:js|mjs|cjs|ts|mts|cts|tsx|jsx|json|rs|py|toml)$/,
  /^scripts\/.*\.(?:js|mjs|cjs|ts)$/,
  /^\.github\/workflows\/.*\.(?:yml|yaml)$/,
];

const forbiddenReferencePatterns = [
  {
    pattern: /@ax-fabric-enterprise\//,
    reason: "private enterprise package namespace",
  },
  {
    pattern: /@ax-fabric\/enterprise-[A-Za-z0-9_-]*/,
    reason: "enterprise-only package reference",
  },
  {
    pattern: /@ax-fabric\/[A-Za-z0-9_-]*-enterprise\b/,
    reason: "enterprise-only package reference",
  },
  {
    pattern: /["'`][^"'`\n]*(?:^|\/)(?:enterprise|private|ee)\/[^"'`\n]*["'`]/,
    reason: "private source path reference",
  },
];

function getTrackedFiles() {
  const output = execFileSync("git", ["ls-files"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function findViolations(files) {
  return files.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)));
}

function shouldCheckReferences(file) {
  return referenceCheckFilePatterns.some((pattern) => pattern.test(file));
}

function findReferenceViolations(files) {
  const violations = [];

  for (const file of files) {
    if (!shouldCheckReferences(file)) {
      continue;
    }

    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const rule of forbiddenReferencePatterns) {
        if (rule.pattern.test(line)) {
          violations.push({
            file,
            line: index + 1,
            reason: rule.reason,
            text: line.trim(),
          });
        }
      }
    }
  }

  return violations;
}

const files = getTrackedFiles();
const violations = findViolations(files);
const referenceViolations = findReferenceViolations(files);

if (violations.length > 0) {
  console.error("Open-core boundary check failed.");
  console.error("The public repository must not contain enterprise-only source roots.");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

if (referenceViolations.length > 0) {
  console.error("Open-core boundary check failed.");
  console.error("The public repository must not reference private enterprise namespaces or private source paths.");
  for (const violation of referenceViolations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.reason}] ${violation.text}`);
  }
  process.exit(1);
}

console.log("Open-core boundary check passed.");
