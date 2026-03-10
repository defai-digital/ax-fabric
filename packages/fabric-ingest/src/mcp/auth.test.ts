/**
 * Tests for MCP auth token management — ADR-029.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateToken, validateToken } from "./auth.js";

describe("MCP Auth", () => {
  describe("generateToken", () => {
    it("generates a token with axf_tk_ prefix", () => {
      const token = generateToken();
      expect(token.startsWith("axf_tk_")).toBe(true);
    });

    it("generates tokens of consistent length", () => {
      const t1 = generateToken();
      const t2 = generateToken();
      // prefix (7) + 32 base62 chars = 39
      expect(t1.length).toBe(39);
      expect(t2.length).toBe(39);
    });

    it("generates unique tokens", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateToken());
      }
      expect(tokens.size).toBe(100);
    });

    it("generates tokens with only base62 characters after prefix", () => {
      const token = generateToken();
      const body = token.slice(7); // remove "axf_tk_"
      expect(body).toMatch(/^[0-9A-Za-z]+$/);
    });
  });

  describe("validateToken", () => {
    it("returns true for matching tokens", () => {
      const token = generateToken();
      expect(validateToken(token, token)).toBe(true);
    });

    it("returns false for different tokens", () => {
      const t1 = generateToken();
      const t2 = generateToken();
      expect(validateToken(t1, t2)).toBe(false);
    });

    it("returns false for different-length tokens", () => {
      const token = generateToken();
      expect(validateToken(token, token + "x")).toBe(false);
    });

    it("returns false when provided token is shorter", () => {
      const token = generateToken();
      expect(validateToken("short", token)).toBe(false);
    });

    it("returns false when provided token is longer", () => {
      const token = generateToken();
      expect(validateToken(token + "extra", token)).toBe(false);
    });

    it("is constant-time (uses timingSafeEqual)", () => {
      // This is a structural test — we verify it works correctly
      // rather than timing it (timing tests are flaky)
      const token = generateToken();
      const almostSame = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
      expect(validateToken(token, almostSame)).toBe(false);
    });
  });
});
