import { describe, expect, it } from "vitest";
import { parseCommandLine } from "./command.js";

describe("parseCommandLine", () => {
  it("parses simple command and args", () => {
    const parsed = parseCommandLine("uvx my-server --model nomic");
    expect(parsed.command).toBe("uvx");
    expect(parsed.args).toEqual(["my-server", "--model", "nomic"]);
  });

  it("parses quoted arguments", () => {
    const parsed = parseCommandLine("python -m module --name \"hello world\"");
    expect(parsed.command).toBe("python");
    expect(parsed.args).toEqual(["-m", "module", "--name", "hello world"]);
  });

  it("supports escaped spaces", () => {
    const parsed = parseCommandLine("cmd path\\ with\\ spaces");
    expect(parsed.command).toBe("cmd");
    expect(parsed.args).toEqual(["path with spaces"]);
  });

  it("throws on empty input", () => {
    expect(() => parseCommandLine("   ")).toThrow(Error);
  });

  it("throws on unmatched quote", () => {
    expect(() => parseCommandLine("cmd \"unterminated")).toThrow(Error);
  });
});
