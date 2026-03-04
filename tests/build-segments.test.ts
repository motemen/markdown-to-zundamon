import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { buildSegments, parseMarkdown, type SynthesizeFn } from "../scripts/preprocess-core";
import { ManifestConfigSchema } from "../src/types";
import type { ManifestConfig } from "../src/types";

/** Mock synthesizer that returns a fixed duration */
function createMockSynthesize(durationSec = 1.0): SynthesizeFn {
  return async (text, speakerId) => ({
    audioPath: `mock/audio/${speakerId}-${text.slice(0, 10)}.wav`,
    durationSec,
  });
}

function makeConfig(overrides: Record<string, unknown> = {}): ManifestConfig {
  return ManifestConfigSchema.parse({
    characters: [{ name: "ずんだもん", speakerId: 3 }],
    ...overrides,
  });
}

function parseWithFrontmatter(raw: string) {
  const { data: frontmatter, content } = matter(raw);
  const config = ManifestConfigSchema.parse(frontmatter);
  const tree = parseMarkdown(content);
  return { config, tree };
}

describe("buildSegments snapshot tests", () => {
  it("single character simple speech", async () => {
    const config = makeConfig();
    const tree = parseMarkdown("こんにちは！ずんだもんなのだ。\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    expect(segments).toMatchSnapshot();
  });

  it("heading creates chapter segment with transition pause", async () => {
    const config = makeConfig();
    const tree = parseMarkdown(`
こんにちは

# チャプター1

これはチャプター1の内容なのだ
`);
    const segments = await buildSegments(tree, config, createMockSynthesize());

    expect(segments).toMatchSnapshot();
  });

  it("blockquote creates slide segment", async () => {
    const config = makeConfig();
    const tree = parseMarkdown(`
> # タイトルスライド

こんにちは！
`);
    const segments = await buildSegments(tree, config, createMockSynthesize());

    expect(segments).toMatchSnapshot();
  });

  it("pause directive creates pause segment", async () => {
    const config = makeConfig();
    const tree = parseMarkdown(`
こんにちは
[pause: 500ms]
さようなら
`);
    const segments = await buildSegments(tree, config, createMockSynthesize());

    expect(segments).toMatchSnapshot();
  });

  it("multi-character with speaker tags", async () => {
    const config = makeConfig({
      characters: [
        { name: "ずんだもん", speakerId: 3 },
        { name: "四国めたん", speakerId: 2 },
      ],
    });
    const tree = parseMarkdown(`
[ずんだもん] こんにちは！
[四国めたん] よろしくね。
`);
    const segments = await buildSegments(tree, config, createMockSynthesize());

    expect(segments).toMatchSnapshot();
  });

  it("example-single.md produces expected timeline structure", async () => {
    const { config, tree } = parseWithFrontmatter(`---
characters:
  - name: ずんだもん
    speakerId: 3
---

> # markdown-to-zundamon

こんにちは！ ずんだもんなのだ。
今日はぼくひとりで、markdown-to-zundamonを紹介するのだ！

> - 動画づくりって大変
> - 文章なら書けるけど…

世はまさに動画時代！
でも、動画を作るのは一苦労だよね？

> ## markdown-to-zundamon とは
>
> Markdownを書くだけで、ずんだもんが解説してくれる動画を自動生成！

そこで markdown-to-zundamon なのだ！
[pause: 500ms]
これさえあれば、Markdownファイルからずんだもん動画を生成できるのだ！
`);

    const segments = await buildSegments(tree, config, createMockSynthesize());

    expect(segments).toMatchSnapshot();
  });

  it("example.md with two characters produces expected timeline structure", async () => {
    const { config, tree } = parseWithFrontmatter(`---
fps: 30
characters:
  - name: ずんだもん
    speakerId: 3
  - name: 四国めたん
    speakerId: 2
---

# イントロ

> # markdown-to-zundamon

[ずんだもん] こんにちは！ ずんだもんなのだ。
[四国めたん] 四国めたんよ。よろしくね。

> - 動画づくりって大変
> - 文章なら書けるけど…

[ずんだもん] 世はまさに動画時代！
[四国めたん] 文章なら書けるってキミも、動画を作るのは一苦労よね？

## ツールの紹介

> ## markdown-to-zundamon とは
>
> Markdownを書くだけで、ずんだもんが解説してくれる動画を自動生成！

[ずんだもん] そこで markdown-to-zundamon なのだ！
[pause: 500ms]
[四国めたん] これさえあれば、Markdownファイルからずんだもん動画を生成できるのよ！
`);

    const segments = await buildSegments(tree, config, createMockSynthesize());

    expect(segments).toMatchSnapshot();
  });
});

describe("buildSegments structural checks", () => {
  it("speechGap inserts pause between consecutive speech lines", async () => {
    const config = makeConfig({ speechGapMs: 200 });
    const tree = parseMarkdown("行1\n行2\n行3\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    const types = segments.map((s) => s.type);
    // speech, pause, speech, pause, speech
    expect(types).toEqual(["speech", "pause", "speech", "pause", "speech"]);
  });

  it("paragraphGap inserts pause between paragraphs", async () => {
    const config = makeConfig({ paragraphGapMs: 400, speechGapMs: 0 });
    const tree = parseMarkdown("段落1\n\n段落2\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    const types = segments.map((s) => s.type);
    expect(types).toEqual(["speech", "pause", "speech"]);
    // The pause should be the paragraph gap
    const pauseSeg = segments.find((s) => s.type === "pause");
    expect(pauseSeg?.durationInFrames).toBe(Math.ceil((400 / 1000) * 30));
  });

  it("no transition pause before first slide", async () => {
    const config = makeConfig();
    const tree = parseMarkdown("> スライド1\n\nテキスト\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    // First segment should be the slide, not a pause
    expect(segments[0].type).toBe("slide");
  });

  it("transition pause before slide after speech", async () => {
    const config = makeConfig({ slideTransitionMs: 600 });
    const tree = parseMarkdown("テキスト\n\n> スライド\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    const types = segments.map((s) => s.type);
    // speech, pause (transition), slide
    expect(types).toContain("slide");
    const slideIdx = types.indexOf("slide");
    expect(types[slideIdx - 1]).toBe("pause");
  });

  it("no transition pause between chapter and immediately following slide", async () => {
    const config = makeConfig();
    const tree = parseMarkdown("# チャプター\n\n> スライド\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    const types = segments.map((s) => s.type);
    // chapter directly followed by slide (no extra pause between them)
    const chapterIdx = types.indexOf("chapter");
    expect(types[chapterIdx + 1]).toBe("slide");
  });

  it("chapter segment has durationInFrames: 0", async () => {
    const config = makeConfig();
    const tree = parseMarkdown("# タイトル\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    const chapter = segments.find((s) => s.type === "chapter");
    expect(chapter?.durationInFrames).toBe(0);
    expect(chapter?.chapterLevel).toBe(1);
  });

  it("slide segment has durationInFrames: 0 and contains markdown", async () => {
    const config = makeConfig();
    const tree = parseMarkdown("> スライド内容\n");

    const segments = await buildSegments(tree, config, createMockSynthesize());

    const slide = segments.find((s) => s.type === "slide");
    expect(slide?.durationInFrames).toBe(0);
    expect(slide?.markdown).toBeDefined();
  });

  it("speech duration depends on synthesizer output", async () => {
    const config = makeConfig();
    const tree = parseMarkdown("テスト\n");

    const segments2sec = await buildSegments(tree, config, createMockSynthesize(2.0));
    const segments05sec = await buildSegments(tree, config, createMockSynthesize(0.5));

    const speech2 = segments2sec.find((s) => s.type === "speech")!;
    const speech05 = segments05sec.find((s) => s.type === "speech")!;
    expect(speech2.durationInFrames).toBe(Math.ceil(2.0 * 30));
    expect(speech05.durationInFrames).toBe(Math.ceil(0.5 * 30));
  });

  it("ruby tags: display text goes to segment, speech text goes to synthesizer", async () => {
    const config = makeConfig();
    const tree = parseMarkdown("<ruby>漢字<rt>かんじ</rt></ruby>のテスト\n");

    let calledWith = "";
    const mockSynth: SynthesizeFn = async (text, _speakerId) => {
      calledWith = text;
      return { audioPath: "mock.wav", durationSec: 1.0 };
    };

    const segments = await buildSegments(tree, config, mockSynth);

    const speech = segments.find((s) => s.type === "speech");
    expect(speech?.text).toBe("漢字のテスト");
    expect(calledWith).toBe("かんじのテスト");
  });
});
