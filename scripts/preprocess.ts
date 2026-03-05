import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { toString } from "mdast-util-to-string";
import matter from "gray-matter";
import * as fs from "fs";
import * as path from "path";
import type { Segment, Manifest, ManifestConfig, Character } from "../src/types";
import { ManifestConfigSchema } from "../src/types";
import {
  sanitizeForFilename,
  shortHash,
  processRubyTags,
  parsePauseDirective,
  parseSpeakerTag,
  buildCharacterMap,
  buildSegments,
  parseMarkdown,
} from "./preprocess-core";

const VOICEVOX_BASE = process.env.VOICEVOX_BASE ?? "http://localhost:50021";

const BASE_PUBLIC_DIR = path.resolve(__dirname, "../public/projects");

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

  const tree = parseMarkdown(mdContent);

  fs.mkdirSync(audioDir, { recursive: true });

  // Use buildSegments with a synthesize wrapper that handles file I/O
  const segments = await buildSegments(tree, config, async (text, speakerId) => {
    return synthesize(text, speakerId, audioDir, projectName);
  });

  // For blockquotes with images, we need to re-process them
  // (buildSegments uses blockquoteToMarkdownSync which skips image processing)
  // Re-parse and process images for slide segments
  const tree2 = parseMarkdown(mdContent);
  let slideIdx = 0;
  for (const node of (tree2 as any).children) {
    if (node.type === "blockquote") {
      const markdown = await blockquoteToMarkdown(node, mdDir, imagesDir, projectName);
      // Find the corresponding slide segment and update its markdown
      for (let i = slideIdx; i < segments.length; i++) {
        if (segments[i].type === "slide") {
          segments[i].markdown = markdown;
          slideIdx = i + 1;
          break;
        }
      }
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

  // Output chapter timestamps
  const chapters: { title: string; frame: number }[] = [];
  let framePos = 0;
  for (const seg of segments) {
    if (seg.type === "chapter") {
      chapters.push({ title: seg.text, frame: framePos });
    }
    framePos += seg.durationInFrames;
  }
  if (chapters.length > 0) {
    console.log(`\nChapters:`);
    const lines: string[] = [];
    for (const ch of chapters) {
      const totalSec = ch.frame / config.fps;
      const min = Math.floor(totalSec / 60);
      const sec = Math.floor(totalSec % 60);
      const ts = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
      console.log(`  ${ts} ${ch.title}`);
      lines.push(`${ts} ${ch.title}`);
    }
    const chaptersPath = path.join(projectDir, "chapters.txt");
    fs.writeFileSync(chaptersPath, lines.join("\n") + "\n");
    console.log(`Chapters written to ${chaptersPath}`);
  }

  console.log(`\nNext steps:`);
  console.log(`  Preview: npm run studio -- ${projectName}`);
  console.log(`  Render:  npm run render -- ${projectName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
