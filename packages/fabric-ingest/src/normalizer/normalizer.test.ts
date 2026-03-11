import { describe, it, expect } from "vitest";
import { normalize, NORMALIZER_VERSION } from "./normalizer.js";

describe("NORMALIZER_VERSION", () => {
  it("exports a valid semver string", () => {
    expect(NORMALIZER_VERSION).toBe("1.0.0");
  });
});

describe("normalize", () => {
  it("returns empty string for empty input", () => {
    expect(normalize("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalize("   \n\n\t  ")).toBe("");
  });

  it("applies Unicode NFC normalization", () => {
    // e + combining acute (NFD) -> e-acute (NFC)
    const nfd = "e\u0301"; // decomposed form
    const nfc = "\u00E9"; // composed form
    expect(normalize(nfd)).toBe(nfc);
  });

  it("normalizes CRLF to LF", () => {
    expect(normalize("line1\r\nline2")).toBe("line1\nline2");
  });

  it("normalizes standalone CR to LF", () => {
    expect(normalize("line1\rline2")).toBe("line1\nline2");
  });

  it("handles mixed line endings", () => {
    expect(normalize("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("replaces tabs with single space", () => {
    expect(normalize("hello\tworld")).toBe("hello world");
  });

  it("replaces multiple tabs with single spaces then collapses", () => {
    expect(normalize("a\t\tb")).toBe("a b");
  });

  it("collapses multiple spaces into one", () => {
    expect(normalize("hello     world")).toBe("hello world");
  });

  it("preserves single newlines", () => {
    expect(normalize("line1\nline2")).toBe("line1\nline2");
  });

  it("preserves double newlines (paragraph breaks)", () => {
    expect(normalize("para1\n\npara2")).toBe("para1\n\npara2");
  });

  it("collapses 3+ newlines into exactly 2", () => {
    expect(normalize("para1\n\n\npara2")).toBe("para1\n\npara2");
    expect(normalize("para1\n\n\n\n\npara2")).toBe("para1\n\npara2");
  });

  it("trims leading whitespace", () => {
    expect(normalize("  hello")).toBe("hello");
  });

  it("trims trailing whitespace", () => {
    expect(normalize("hello  ")).toBe("hello");
  });

  it("trims leading and trailing newlines", () => {
    expect(normalize("\n\nhello\n\n")).toBe("hello");
  });

  it("is deterministic — same input gives same output", () => {
    const input = "  Hello\r\n\tWorld\n\n\n  Foo  ";
    const first = normalize(input);
    const second = normalize(input);
    expect(first).toBe(second);
    expect(first).toBe("Hello\n World\n\n Foo");
  });

  it("applies all steps in correct order", () => {
    // Input with all issues: NFC, CRLF, tabs, multi-space, multi-newline, trim
    const input = "  e\u0301\r\n\thello   world\n\n\n\nfoo  ";
    const result = normalize(input);

    // NFC: e+combining -> e-acute
    expect(result).toContain("\u00E9");
    // CRLF -> LF, tab -> space
    // multi-space collapsed, 4 newlines -> 2, trimmed
    expect(result).toBe("\u00E9\n hello world\n\nfoo");
  });

  it("handles text with no transformations needed", () => {
    const clean = "Hello world\n\nParagraph two";
    expect(normalize(clean)).toBe(clean);
  });

  it("handles single character input", () => {
    expect(normalize("x")).toBe("x");
  });

  it("handles newlines between spaces correctly", () => {
    // Spaces are collapsed per-run but newlines are preserved as-is
    // "a   \n   b" -> (collapse spaces) "a \n b"
    expect(normalize("a   \n   b")).toBe("a \n b");
  });

  it("is idempotent — normalizing twice gives the same result", () => {
    const inputs = [
      "  Hello\r\n\tWorld\n\n\n  Foo  ",
      "a\t\tb\r\nc\r\nd",
      "e\u0301 test",
    ];
    for (const input of inputs) {
      const once = normalize(input);
      const twice = normalize(once);
      expect(twice).toBe(once);
    }
  });

  it("handles only-tabs input", () => {
    expect(normalize("\t\t\t")).toBe("");
  });

  it("collapses mixed tabs and spaces into single space", () => {
    // tab -> space, then multiple spaces -> one space
    expect(normalize("a\t  \tb")).toBe("a b");
  });

  it("preserves exactly two newlines (does not collapse double newlines)", () => {
    // Two consecutive newlines should be preserved unchanged
    expect(normalize("x\n\ny")).toBe("x\n\ny");
  });

  it("collapses exactly 3 newlines to 2", () => {
    expect(normalize("x\n\n\ny")).toBe("x\n\ny");
  });

  it("handles CRLF followed by CR", () => {
    // \r\n -> \n, standalone \r -> \n: "a\r\n\rb" -> "a\n\nb"
    expect(normalize("a\r\n\rb")).toBe("a\n\nb");
  });
});
