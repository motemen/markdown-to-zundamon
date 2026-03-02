import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { toString } from "mdast-util-to-string";
import matter from "gray-matter";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Segment, Manifest, ManifestConfig, Character } from "../src/types";
import { ManifestConfigSchema } from "../src/types";

const VOICEVOX_BASE = process.env.VOICEVOX_BASE ?? "http://localhost:50021";

const BASE_PUBLIC_DIR = path.resolve(__dirname, "../public/projects");

function sanitizeForFilename(text: string): string {
  return text
    .slice(0, 20)
    .replace(/[\/\\:*?"<>|.\s]/g, "_")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
}

function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Parse WAV header to get duration in seconds */
function getWavDurationSec(filePath: string): number {
  const buf = fs.readFileSync(filePath);
  const byteRate = buf.readUInt32LE(28);
  let dataOffset = 12;
  while (dataOffset < buf.length - 8) {
    const chunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
    const chunkSize = buf.readUInt32LE(dataOffset + 4);
    if (chunkId === "data") {
      return chunkSize / byteRate;
    }
    dataOffset += 8 + chunkSize;
  }
  throw new Error(`Could not find data chunk in WAV: ${filePath}`);
}

async function synthesize(
  text: string,
  speakerId: number,
  audioDir: string,
  projectName: string
): Promise<{ audioPath: string; durationSec: number }> {
  const hash = shortHash(text);
  const sanitized = sanitizeForFilename(text);
  const filename = `${hash}-${sanitized}.wav`;
  const audioPath = path.join(audioDir, filename);

  if (fs.existsSync(audioPath)) {
    console.log(`  [cache] ${filename}`);
    const durationSec = getWavDurationSec(audioPath);
    return { audioPath: `projects/${projectName}/audio/${filename}`, durationSec };
  }

  let queryRes: Response;
  try {
    queryRes = await fetch(
      `${VOICEVOX_BASE}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: "POST" }
    );
  } catch (err) {
    throw new Error(
      `VOICEVOX に接続できません (${VOICEVOX_BASE})\n` +
      `  VOICEVOX が起動しているか確認してください。\n` +
      `  別のホストで動いている場合は環境変数 VOICEVOX_BASE を設定してください。\n` +
      `  例: VOICEVOX_BASE=http://192.168.1.100:50021 npm run preprocess -- ...\n` +
      `  原因: ${err instanceof Error ? err.message : err}`
    );
  }
  if (!queryRes.ok) {
    const body = await queryRes.text();
    throw new Error(
      `VOICEVOX audio_query が失敗しました (speaker=${speakerId}, text="${text.slice(0, 30)}...")\n` +
      `  ステータス: ${queryRes.status}\n` +
      `  レスポンス: ${body}`
    );
  }
  const audioQuery = await queryRes.json();

  let synthRes: Response;
  try {
    synthRes = await fetch(
      `${VOICEVOX_BASE}/synthesis?speaker=${speakerId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(audioQuery),
      }
    );
  } catch (err) {
    throw new Error(
      `VOICEVOX synthesis リクエストに失敗しました (${VOICEVOX_BASE})\n` +
      `  原因: ${err instanceof Error ? err.message : err}`
    );
  }
  if (!synthRes.ok) {
    const body = await synthRes.text();
    throw new Error(
      `VOICEVOX synthesis が失敗しました (speaker=${speakerId})\n` +
      `  ステータス: ${synthRes.status}\n` +
      `  レスポンス: ${body}`
    );
  }

  const wavBuffer = Buffer.from(await synthRes.arrayBuffer());
  fs.writeFileSync(audioPath, wavBuffer);
  console.log(`  [synth] ${filename}`);

  const durationSec = getWavDurationSec(audioPath);
  return { audioPath: `projects/${projectName}/audio/${filename}`, durationSec };
}

/**
 * Walk AST to find image nodes, copy/download referenced files to public/<project>/images/,
 * and rewrite URLs to be relative to public/.
 */
async function processImages(
  node: any,
  mdDir: string,
  imagesDir: string,
  projectName: string
): Promise<void> {
  if (node.type === "image" && node.url) {
    const url: string = node.url;

    if (url.startsWith("http://") || url.startsWith("https://")) {
      // Download remote image
      const hash = shortHash(url);
      const urlPath = new URL(url).pathname;
      const ext = path.extname(urlPath) || ".jpg";
      const destName = `${hash}${ext}`;

      fs.mkdirSync(imagesDir, { recursive: true });
      const destPath = path.join(imagesDir, destName);

      if (!fs.existsSync(destPath)) {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`  [warn] Failed to download image: ${url}`);
          return;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(destPath, buf);
        console.log(`  [image] ${url} → projects/${projectName}/images/${destName}`);
      } else {
        console.log(`  [cache] projects/${projectName}/images/${destName}`);
      }

      node.url = `projects/${projectName}/images/${destName}`;
    } else {
      // Local image
      const srcPath = path.resolve(mdDir, url);
      if (!fs.existsSync(srcPath)) {
        console.warn(`  [warn] Image not found: ${srcPath}`);
        return;
      }

      const hash = shortHash(srcPath);
      const ext = path.extname(srcPath);
      const baseName = path.basename(srcPath, ext);
      const destName = `${hash}-${sanitizeForFilename(baseName)}${ext}`;

      fs.mkdirSync(imagesDir, { recursive: true });
      const destPath = path.join(imagesDir, destName);
      fs.copyFileSync(srcPath, destPath);
      console.log(
        `  [image] ${path.basename(srcPath)} → ${projectName}/images/${destName}`
      );

      // Rewrite URL to public-relative path for staticFile()
      node.url = `projects/${projectName}/images/${destName}`;
    }
  }

  if (node.children) {
    for (const child of node.children) {
      await processImages(child, mdDir, imagesDir, projectName);
    }
  }
}

/** Convert a blockquote AST node back to markdown string */
async function blockquoteToMarkdown(
  node: any,
  mdDir: string,
  imagesDir: string,
  projectName: string
): Promise<string> {
  // Process images before serializing
  await processImages(node, mdDir, imagesDir, projectName);
  const processor = unified().use(remarkStringify);
  const virtualRoot = { type: "root" as const, children: node.children };
  return processor.stringify(virtualRoot).trim();
}

/**
 * Process <ruby> tags to separate display text and speech text (reading).
 * <ruby>表示<rt>よみ</rt></ruby> → displayText: "表示", speechText: "よみ"
 * Also handles optional <rp> tags.
 */
function processRubyTags(text: string): { displayText: string; speechText: string } {
  const rubyRe = /<ruby>(.*?)<rt>(.*?)<\/rt><\/ruby>/g;
  const displayText = text.replace(rubyRe, (_match, base) => base);
  const speechText = text.replace(rubyRe, (_match, _base, reading) => reading);
  return { displayText, speechText };
}

/** Parse [pause: 500ms] directives from text, returning speech lines and pause segments */
const PAUSE_RE = /^\[pause:\s*(\d+)(ms|s)\]$/;

function parsePauseDirective(
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

function parseSpeakerTag(
  line: string
): { character: string; text: string } | null {
  const m = line.match(SPEAKER_TAG_RE);
  if (!m) return null;
  // Don't match pause directives
  if (PAUSE_RE.test(line.trim())) return null;
  return { character: m[1], text: line.slice(m[0].length) };
}

/** Build a map from character name to Character config */
function buildCharacterMap(
  characters: Character[],
  defaultSpeakerId: number
): Map<string, Character> {
  const map = new Map<string, Character>();
  for (const c of characters) {
    map.set(c.name, c);
  }
  return map;
}

/** Copy character images to public directory */
function copyCharacterImages(characters: Character[]): void {
  for (const char of characters) {
    const charSrc = path.resolve(__dirname, `../characters/${char.name}/default.png`);
    const charDst = path.resolve(
      __dirname,
      `../public/characters/${char.name}/default.png`
    );
    if (fs.existsSync(charSrc)) {
      fs.mkdirSync(path.dirname(charDst), { recursive: true });
      fs.copyFileSync(charSrc, charDst);
      console.log(`  [char] ${char.name} → characters/${char.name}/default.png`);
    } else {
      console.warn(`  [warn] Character image not found: ${charSrc}`);
    }

    // Copy active images for lip-sync animation (default_active1.png, default_active2.png, ...)
    const charDir = path.resolve(__dirname, `../characters/${char.name}`);
    const activeFiles = fs.readdirSync(charDir)
      .filter((f) => /^default_active\d+\.png$/.test(f))
      .sort();
    if (activeFiles.length > 0) {
      char.activeImages = [];
      for (const file of activeFiles) {
        const activeSrc = path.join(charDir, file);
        const activeDst = path.resolve(
          __dirname,
          `../public/characters/${char.name}/${file}`
        );
        fs.copyFileSync(activeSrc, activeDst);
        char.activeImages.push(file);
        console.log(`  [char] ${char.name} → characters/${char.name}/${file}`);
      }
    }
  }
}

async function main() {
  const mdPath = process.argv[2];
  if (!mdPath) {
    console.error("Usage: ts-node scripts/preprocess.ts <markdown-file>");
    process.exit(1);
  }

  const resolvedMdPath = path.resolve(mdPath);
  const mdDir = path.dirname(resolvedMdPath);

  // Derive project name from input filename (without extension)
  const projectName = path.basename(resolvedMdPath, path.extname(resolvedMdPath));
  const projectDir = path.join(BASE_PUBLIC_DIR, projectName);
  const audioDir = path.join(projectDir, "audio");
  const imagesDir = path.join(projectDir, "images");

  console.log(`Project: "${projectName}" → public/projects/${projectName}/`);

  const raw = fs.readFileSync(resolvedMdPath, "utf-8");
  const { data: frontmatter, content: mdContent } = matter(raw);

  // Merge config from frontmatter (ManifestConfigSchema provides defaults)
  const config = ManifestConfigSchema.parse(frontmatter);

  // Default position for characters[1] is "left" (if not explicitly set)
  if (config.characters.length > 1) {
    const raw1 = (frontmatter.characters as Record<string, unknown>[])?.[1];
    if (raw1 && !raw1.position) {
      config.characters[1].position = "left";
    }
  }

  const tree = unified().use(remarkParse).parse(mdContent);

  fs.mkdirSync(audioDir, { recursive: true });

  const segments: Segment[] = [];

  // Build character map for speaker tag resolution
  const characterMap = buildCharacterMap(config.characters, config.speakerId);
  // When only one character, use it as default (no tag needed)
  const defaultCharacter =
    config.characters.length === 1 ? config.characters[0] : undefined;

  let prevNodeHadSpeech = false;

  for (const node of tree.children) {
    if (node.type === "blockquote") {
      const text = toString(node);
      const markdown = await blockquoteToMarkdown(node, mdDir, imagesDir, projectName);
      console.log(`[slide] ${text.slice(0, 40)}...`);
      // Add transition pause before slide (except for the first segment)
      const slideTransitionFrames = Math.ceil((config.slideTransitionMs / 1000) * config.fps);
      if (segments.length > 0 && slideTransitionFrames > 0) {
        segments.push({
          type: "pause",
          text: "",
          durationInFrames: slideTransitionFrames,
        });
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

      // Insert paragraph gap if previous node produced speech
      if (prevNodeHadSpeech) {
        const paragraphGapFrames = Math.ceil(
          (config.paragraphGapMs / 1000) * config.fps
        );
        if (paragraphGapFrames > 0) {
          segments.push({
            type: "pause",
            text: "",
            durationInFrames: paragraphGapFrames,
          });
        }
      }

      // Each line is a separate speech segment; [pause: ...] is a directive
      const lines = fullText.split("\n");
      const speechGapFrames = Math.ceil(
        (config.speechGapMs / 1000) * config.fps
      );
      let speechCount = 0;

      // Track current speaker within a paragraph
      let currentCharacterName: string | undefined = defaultCharacter?.name;
      let currentSpeakerId: number = defaultCharacter?.speakerId ?? config.speakerId;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const pause = parsePauseDirective(trimmed);
        if (pause) {
          const durationInFrames = Math.ceil(
            (pause.ms / 1000) * config.fps
          );
          console.log(`[pause] ${pause.ms}ms (${durationInFrames} frames)`);
          segments.push({
            type: "pause",
            text: "",
            durationInFrames,
          });
          speechCount = 0; // reset so next speech doesn't get a gap
        } else {
          // Parse speaker tag
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
              console.warn(
                `  [warn] Unknown character "${speakerTag.character}", using default`
              );
              speechText = speakerTag.text;
              characterName = defaultCharacter?.name;
              speakerId = defaultCharacter?.speakerId ?? config.speakerId;
            }
            // Update current speaker for subsequent lines
            currentCharacterName = characterName;
            currentSpeakerId = speakerId;
          }
          // Lines without a speaker tag inherit the current speaker

          // Skip lines with no speech text (speaker tag only)
          if (!speechText.trim()) continue;

          // Process <ruby> tags: display text for subtitles, speech text for VOICEVOX
          const { displayText, speechText: voicevoxText } = processRubyTags(speechText);

          // Insert gap between consecutive speech lines
          if (speechCount > 0 && speechGapFrames > 0) {
            segments.push({
              type: "pause",
              text: "",
              durationInFrames: speechGapFrames,
            });
          }

          console.log(`[speech] ${displayText.slice(0, 40)}...`);
          const { audioPath, durationSec } = await synthesize(
            voicevoxText,
            speakerId,
            audioDir,
            projectName
          );
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

  // Copy character images (before manifest write so activeImages is populated)
  copyCharacterImages(config.characters);

  // Copy BGM file if configured
  let bgmFile: string | undefined;
  if (config.bgm) {
    const bgmSrc = config.bgm.src;
    // Try resolving: 1) relative to md file, 2) relative to project root
    const candidates = [
      path.resolve(mdDir, bgmSrc),
      path.resolve(__dirname, "..", bgmSrc),
    ];
    const resolvedBgm = candidates.find((p) => fs.existsSync(p));
    if (!resolvedBgm) {
      throw new Error(
        `BGM file not found: "${bgmSrc}"\n` +
        `  Tried:\n` +
        candidates.map((p) => `    - ${p}`).join("\n")
      );
    }
    const bgmDir = path.join(projectDir, "bgm");
    fs.mkdirSync(bgmDir, { recursive: true });
    const bgmFilename = path.basename(resolvedBgm);
    const bgmDest = path.join(bgmDir, bgmFilename);
    fs.copyFileSync(resolvedBgm, bgmDest);
    bgmFile = `projects/${projectName}/bgm/${bgmFilename}`;
    console.log(`  [bgm] ${bgmSrc} → ${bgmFile}`);
  }

  const totalDurationInFrames = segments.reduce(
    (sum, s) => sum + s.durationInFrames,
    0
  );

  const manifest: Manifest = {
    config,
    totalDurationInFrames,
    segments,
    ...(bgmFile ? { bgmFile } : {}),
  };

  const manifestPath = path.join(projectDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to ${manifestPath}`);
  console.log(
    `Total duration: ${totalDurationInFrames} frames (${(totalDurationInFrames / config.fps).toFixed(1)}s)`
  );

  console.log(`\nNext steps:`);
  console.log(`  Preview: npm run studio -- ${projectName}`);
  console.log(`  Render:  npm run render -- ${projectName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
