import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { toString } from "mdast-util-to-string";
import * as crypto from "crypto";
import type { Segment, ManifestConfig, Character } from "../src/types";

export function sanitizeForFilename(text: string): string {
  return text
    .slice(0, 20)
    .replace(/[\/\\:*?"<>|.\s]/g, "_")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
}

export function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * Process <ruby> tags to separate display text and speech text (reading).
 * <ruby>表示<rt>よみ</rt></ruby> → displayText: "表示", speechText: "よみ"
 */
export function processRubyTags(text: string): { displayText: string; speechText: string } {
  const rubyRe = /<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>/g;
  const displayText = text.replace(rubyRe, (_match, base) => base);
  const speechText = text.replace(rubyRe, (_match, _base, reading) => reading);
  return { displayText, speechText };
}

/** Parse [pause: 500ms] directives from text */
const PAUSE_RE = /^\[pause:\s*(\d+)(ms|s)\]$/;

export function parsePauseDirective(
  line: string
): { type: "pause"; ms: number } | null {
  const m = line.trim().match(PAUSE_RE);
  if (!m) return null;
  const value = parseInt(m[1], 10);
  const ms = m[2] === "s" ? value * 1000 : value;
  return { type: "pause", ms };
}

/** Parse speaker tag [キャラ名] from the beginning of a line */
const SPEAKER_TAG_RE = /^\[(.+?)\]\s*/;

export function parseSpeakerTag(
  line: string
): { character: string; text: string } | null {
  const m = line.match(SPEAKER_TAG_RE);
  if (!m) return null;
  if (PAUSE_RE.test(line.trim())) return null;
  return { character: m[1], text: line.slice(m[0].length) };
}

/** Build a map from character name to Character config */
export function buildCharacterMap(
  characters: Character[]
): Map<string, Character> {
  const map = new Map<string, Character>();
  for (const c of characters) {
    map.set(c.name, c);
  }
  return map;
}

/** Convert a blockquote AST node back to markdown string (without image processing) */
export function blockquoteToMarkdownSync(node: any): string {
  const processor = unified().use(remarkStringify);
  const virtualRoot = { type: "root" as const, children: node.children };
  return processor.stringify(virtualRoot).trim();
}

/** Synthesizer function type for dependency injection */
export type SynthesizeFn = (
  text: string,
  speakerId: number
) => Promise<{ audioPath: string; durationSec: number }>;

/**
 * Build segments from a parsed markdown AST and config.
 * The synthesize function is injected for testability.
 */
export async function buildSegments(
  tree: ReturnType<ReturnType<typeof unified>["parse"]>,
  config: ManifestConfig,
  synthesizeFn: SynthesizeFn
): Promise<Segment[]> {
  const segments: Segment[] = [];

  const characterMap = buildCharacterMap(config.characters);
  const defaultCharacter =
    config.characters.length === 1 ? config.characters[0] : undefined;

  let prevNodeHadSpeech = false;

  for (const node of (tree as any).children) {
    if (node.type === "heading") {
      const title = toString(node).trim();
      if (!title) continue;
      const depth = (node as { depth: number }).depth;
      const slideTransitionFrames = Math.ceil((config.slideTransitionMs / 1000) * config.fps);
      const lastSeg = segments[segments.length - 1];
      if (segments.length > 0 && slideTransitionFrames > 0 && lastSeg?.type !== "chapter") {
        segments.push({ type: "pause", text: "", durationInFrames: slideTransitionFrames });
      }
      segments.push({
        type: "chapter",
        text: title,
        durationInFrames: 0,
        chapterLevel: depth,
      });
      prevNodeHadSpeech = false;
    } else if (node.type === "blockquote") {
      const text = toString(node);
      const markdown = blockquoteToMarkdownSync(node);
      const slideTransitionFrames = Math.ceil((config.slideTransitionMs / 1000) * config.fps);
      const lastSeg = segments[segments.length - 1];
      if (segments.length > 0 && slideTransitionFrames > 0 && lastSeg?.type !== "chapter") {
        segments.push({ type: "pause", text: "", durationInFrames: slideTransitionFrames });
      }
      segments.push({
        type: "slide",
        text,
        markdown,
        durationInFrames: 0,
      });
      prevNodeHadSpeech = false;
    } else {
      const fullText = toString(node).trim();
      if (!fullText) continue;

      if (prevNodeHadSpeech) {
        const paragraphGapFrames = Math.ceil((config.paragraphGapMs / 1000) * config.fps);
        if (paragraphGapFrames > 0) {
          segments.push({ type: "pause", text: "", durationInFrames: paragraphGapFrames });
        }
      }

      const lines = fullText.split("\n");
      const speechGapFrames = Math.ceil((config.speechGapMs / 1000) * config.fps);
      let speechCount = 0;

      let currentCharacterName: string | undefined = defaultCharacter?.name;
      let currentSpeakerId: number = defaultCharacter?.speakerId ?? config.speakerId;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const pause = parsePauseDirective(trimmed);
        if (pause) {
          const durationInFrames = Math.ceil((pause.ms / 1000) * config.fps);
          segments.push({ type: "pause", text: "", durationInFrames });
          speechCount = 0;
        } else {
          let speechText = trimmed;
          let speakerId = currentSpeakerId;
          let characterName = currentCharacterName;

          const speakerTag = parseSpeakerTag(trimmed);
          if (speakerTag) {
            const char = characterMap.get(speakerTag.character);
            if (char) {
              speechText = speakerTag.text;
              speakerId = char.speakerId;
              characterName = char.name;
            } else {
              speechText = speakerTag.text;
              characterName = defaultCharacter?.name;
              speakerId = defaultCharacter?.speakerId ?? config.speakerId;
            }
            currentCharacterName = characterName;
            currentSpeakerId = speakerId;
          }

          if (!speechText.trim()) continue;

          const { displayText, speechText: voicevoxText } = processRubyTags(speechText);

          if (speechCount > 0 && speechGapFrames > 0) {
            segments.push({ type: "pause", text: "", durationInFrames: speechGapFrames });
          }

          const { audioPath, durationSec } = await synthesizeFn(voicevoxText, speakerId);
          const durationInFrames = Math.ceil(durationSec * config.fps);
          segments.push({
            type: "speech",
            text: displayText,
            audioFile: audioPath,
            durationInFrames,
            ...(characterName ? { character: characterName } : {}),
          });
          speechCount++;
        }
      }
      prevNodeHadSpeech = speechCount > 0;
    }
  }

  return segments;
}

/** Parse markdown content into an AST */
export function parseMarkdown(mdContent: string) {
  return unified().use(remarkParse).parse(mdContent);
}
