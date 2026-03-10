import { describe, expect, it, vi, beforeEach } from "vitest";
import { Command } from "commander";

import { registerMcpCommand } from "./mcp.js";
import * as auth from "../mcp/auth.js";

vi.mock("../mcp/auth.js", () => ({
  ensureToken: vi.fn(),
  generateToken: vi.fn(),
  readToken: vi.fn(),
  writeToken: vi.fn(),
}));

describe("mcp token CLI", () => {
  const token = "axf_tk_1234567890abcdefghijklmnopqrstuv";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(auth.readToken).mockReturnValue(token);
    vi.mocked(auth.generateToken).mockReturnValue(token);
    vi.mocked(auth.ensureToken).mockReturnValue(token);
  });

  function makeProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerMcpCommand(program);
    return program;
  }

  it("shows masked token by default", async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "mcp", "token", "show"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    logSpy.mockRestore();
    expect(output).not.toContain(token);
    expect(output).toContain("axf_tk_");
    expect(output).toContain("***");
  });

  it("shows full token only with --reveal", async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "mcp", "token", "show", "--reveal"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    logSpy.mockRestore();
    expect(output).toContain(token);
  });

  it("generates token and masks output by default", async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "mcp", "token", "generate"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    logSpy.mockRestore();
    expect(auth.writeToken).toHaveBeenCalledWith(token);
    expect(output).not.toContain(token);
  });
});

