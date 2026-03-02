import { z } from "zod";

// Zod schemas
export const CharacterSchema = z.object({
  name: z.string(),
  speakerId: z.number(),
  position: z.enum(["left", "right"]).default("right"),
  flip: z.boolean().default(false),
  color: z.string().default("#555555"),
  overflowY: z.number().default(0.4),
  overflowX: z.number().default(0.1),
  height: z.number().default(800),
  // image path は name から自動解決: characters/<name>/default.png
  activeImages: z.array(z.string()).optional(),
});

export const BgmConfigSchema = z.object({
  src: z.string(),
  volume: z.number().min(0).max(1).default(0.1),
  fadeInMs: z.number().min(0).default(0),
  fadeOutMs: z.number().min(0).default(1000),
});

export const ManifestConfigSchema = z.object({
  fps: z.number().default(30),
  width: z.number().default(1920),
  height: z.number().default(1080),
  speakerId: z.number().default(3),
  characters: z.array(CharacterSchema).min(1),
  slideTransitionMs: z.number().default(600),
  speechGapMs: z.number().default(200),
  paragraphGapMs: z.number().default(400),
  fontFamily: z.string().default("M PLUS Rounded 1c"),
  subtitleFontFamily: z.string().optional(),
  slideFontFamily: z.string().optional(),
  codeHighlightTheme: z.string().default("oneLight"),
  bgm: BgmConfigSchema.optional(),
});

export const SegmentSchema = z.object({
  type: z.enum(["speech", "slide", "pause"]),
  text: z.string(),
  audioFile: z.string().optional(),
  durationInFrames: z.number(),
  markdown: z.string().optional(),
  character: z.string().optional(),
});

export const ManifestSchema = z.object({
  config: ManifestConfigSchema,
  totalDurationInFrames: z.number(),
  segments: z.array(SegmentSchema),
  bgmFile: z.string().optional(),
});

export const CompositionPropsSchema = z.object({
  projectName: z.string(),
  manifest: ManifestSchema.optional(),
});

// Types derived from schemas
export type Character = z.infer<typeof CharacterSchema>;
export type ManifestConfig = z.infer<typeof ManifestConfigSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type SegmentType = Segment["type"];
export type Manifest = z.infer<typeof ManifestSchema>;
export type CompositionPropsType = z.infer<typeof CompositionPropsSchema>;
