import { describe, it, expect } from "vitest";
import {
  sanitizeForFilename,
  shortHash,
  processRubyTags,
  parsePauseDirective,
  parseSpeakerTag,
  buildCharacterMap,
} from "../scripts/preprocess-core";
import type { Character } from "../src/types";

describe("sanitizeForFilename", () => {
  it("replaces illegal characters with underscore", () => {
    expect(sanitizeForFilename("hello world")).toBe("hello_world");
    expect(sanitizeForFilename("file/name")).toBe("file_name");
    expect(sanitizeForFilename('a:b*c?"d<e>f|g')).toBe("a_b_c_d_e_f_g");
  });

  it("truncates to 20 characters before sanitizing", () => {
    const long = "あいうえおかきくけこさしすせそたちつてとなにぬねの";
    expect(sanitizeForFilename(long).length).toBeLessThanOrEqual(20);
  });

  it("collapses multiple underscores", () => {
    expect(sanitizeForFilename("a  b")).toBe("a_b");
    expect(sanitizeForFilename("a...b")).toBe("a_b");
  });

  it("removes trailing underscore", () => {
    expect(sanitizeForFilename("hello ")).toBe("hello");
  });
});

describe("shortHash", () => {
  it("returns 8-char hex string", () => {
    const hash = shortHash("test");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic", () => {
    expect(shortHash("hello")).toBe(shortHash("hello"));
  });

  it("differs for different inputs", () => {
    expect(shortHash("a")).not.toBe(shortHash("b"));
  });
});

describe("processRubyTags", () => {
  it("separates display text and speech text", () => {
    const result = processRubyTags("<ruby>表示<rt>ひょうじ</rt></ruby>テスト");
    expect(result.displayText).toBe("表示テスト");
    expect(result.speechText).toBe("ひょうじテスト");
  });

  it("handles multiple ruby tags", () => {
    const result = processRubyTags(
      "<ruby>漢字<rt>かんじ</rt></ruby>と<ruby>平仮名<rt>ひらがな</rt></ruby>"
    );
    expect(result.displayText).toBe("漢字と平仮名");
    expect(result.speechText).toBe("かんじとひらがな");
  });

  it("returns text unchanged when no ruby tags", () => {
    const result = processRubyTags("普通のテキスト");
    expect(result.displayText).toBe("普通のテキスト");
    expect(result.speechText).toBe("普通のテキスト");
  });
});

describe("parsePauseDirective", () => {
  it("parses milliseconds", () => {
    expect(parsePauseDirective("[pause: 500ms]")).toEqual({ type: "pause", ms: 500 });
  });

  it("parses seconds and converts to ms", () => {
    expect(parsePauseDirective("[pause: 2s]")).toEqual({ type: "pause", ms: 2000 });
  });

  it("handles whitespace around directive", () => {
    expect(parsePauseDirective("  [pause: 300ms]  ")).toEqual({ type: "pause", ms: 300 });
  });

  it("returns null for non-pause text", () => {
    expect(parsePauseDirective("こんにちは")).toBeNull();
    expect(parsePauseDirective("[ずんだもん] hello")).toBeNull();
  });
});

describe("parseSpeakerTag", () => {
  it("parses speaker tag and text", () => {
    const result = parseSpeakerTag("[ずんだもん] こんにちは！");
    expect(result).toEqual({ character: "ずんだもん", text: "こんにちは！" });
  });

  it("handles speaker tag with no text (tag only)", () => {
    const result = parseSpeakerTag("[四国めたん] ");
    expect(result).toEqual({ character: "四国めたん", text: "" });
  });

  it("returns null for plain text", () => {
    expect(parseSpeakerTag("普通のテキスト")).toBeNull();
  });

  it("does not match pause directives", () => {
    expect(parseSpeakerTag("[pause: 500ms]")).toBeNull();
  });
});

describe("buildCharacterMap", () => {
  it("builds a map from character name to config", () => {
    const characters: Character[] = [
      { name: "ずんだもん", speakerId: 3, position: "right", flip: false, color: "#555", overflowY: 0.4, overflowX: 0.1, height: 800 },
      { name: "四国めたん", speakerId: 2, position: "left", flip: true, color: "#b44", overflowY: 0.4, overflowX: 0.1, height: 800 },
    ];
    const map = buildCharacterMap(characters);
    expect(map.get("ずんだもん")?.speakerId).toBe(3);
    expect(map.get("四国めたん")?.speakerId).toBe(2);
    expect(map.get("存在しない")).toBeUndefined();
  });
});
