import React, { useState, useEffect, useRef } from "react";
import {
  AbsoluteFill,
  Html5Audio,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useDelayRender,
} from "remotion";
import { getAvailableFonts } from "@remotion/google-fonts";
import { CompositionPropsSchema } from "./types";
import { CharacterDisplay } from "./components/CharacterDisplay";
import { Subtitle } from "./components/Subtitle";
import { SlideContent } from "./components/SlideContent";

/**
 * Load Google Fonts via useDelayRender and return resolved CSS font-family names.
 * The actual CSS font name may differ from the config name (e.g. the registry key).
 */
function useGoogleFonts(fontNames: string[]): Map<string, string> {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [resolvedFonts, setResolvedFonts] = useState<Map<string, string>>(
    () => new Map()
  );
  const handleRef = useRef<ReturnType<typeof delayRender> | null>(null);

  // Deduplicate and sort for stable dependency
  const key = [...new Set(fontNames)].sort().join(",");

  useEffect(() => {
    const uniqueNames = [...new Set(fontNames)];
    if (uniqueNames.length === 0) return;

    const handle = delayRender(`Loading fonts: ${uniqueNames.join(", ")}`);
    handleRef.current = handle;

    Promise.all(
      uniqueNames.map(async (name) => {
        const font = getAvailableFonts().find((f) => f.fontFamily === name);
        if (!font) {
          console.warn(`Font "${name}" not found in @remotion/google-fonts`);
          return [name, name] as const;
        }
        const loaded = await font.load();
        await loaded.loadFont().waitUntilDone();
        console.log(
          `Font loaded: "${name}" → CSS family "${loaded.fontFamily}"`
        );
        return [name, loaded.fontFamily] as const;
      })
    )
      .then((entries) => {
        setResolvedFonts(new Map(entries));
        continueRender(handle);
      })
      .catch((err) => {
        cancelRender(err);
      });
  }, [key]);

  return resolvedFonts;
}

export const ZundamonComposition: React.FC<Record<string, unknown>> = (props) => {
  const compositionProps = CompositionPropsSchema.parse(props);
  const { manifest } = compositionProps;
  if (!manifest) {
    throw new Error("manifest is not loaded yet");
  }
  const frame = useCurrentFrame();
  const { segments, config } = manifest;

  // Collect all font names to load
  const fontNames = [config.fontFamily];
  if (config.subtitleFontFamily) fontNames.push(config.subtitleFontFamily);
  if (config.slideFontFamily) fontNames.push(config.slideFontFamily);

  const resolvedFonts = useGoogleFonts(fontNames);

  const resolveFontFamily = (name: string) =>
    resolvedFonts.get(name) ?? name;

  const baseFontFamily = resolveFontFamily(config.fontFamily);
  const subtitleFontFamily = resolveFontFamily(
    config.subtitleFontFamily ?? config.fontFamily
  );
  const slideFontFamily = resolveFontFamily(
    config.slideFontFamily ?? config.fontFamily
  );

  // Build timeline: compute start frame for each segment
  const timeline: { segment: (typeof segments)[number]; startFrame: number }[] =
    [];
  let currentFrame = 0;
  for (const segment of segments) {
    timeline.push({ segment, startFrame: currentFrame });
    currentFrame += segment.durationInFrames;
  }

  // Find current slide: last slide segment whose startFrame <= current frame
  let currentSlideMarkdown: string | null = null;
  for (const entry of timeline) {
    if (entry.segment.type === "slide" && entry.startFrame <= frame) {
      currentSlideMarkdown = entry.segment.markdown ?? entry.segment.text;
    }
  }

  // Find current speech segment for subtitle and active character
  let currentSpeechText: string | null = null;
  let currentSpeechCharacter: string | null = null;
  for (const entry of timeline) {
    if (
      entry.segment.type === "speech" &&
      frame >= entry.startFrame &&
      frame < entry.startFrame + entry.segment.durationInFrames
    ) {
      currentSpeechText = entry.segment.text;
      currentSpeechCharacter = entry.segment.character ?? null;
    }
  }

  // Resolve current speaker's color
  const currentCharConfig = currentSpeechCharacter
    ? config.characters.find((c) => c.name === currentSpeechCharacter)
    : undefined;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#e8f5e9",
        fontFamily: `'${baseFontFamily}', sans-serif`,
      }}
    >

      {/* BGM */}
      {manifest.bgmFile && config.bgm && (
        <Sequence from={0} durationInFrames={manifest.totalDurationInFrames}>
          <Html5Audio
            src={staticFile(manifest.bgmFile)}
            volume={(f) => {
              const fps = config.fps;
              const total = manifest.totalDurationInFrames;
              const fadeInFrames = Math.ceil((config.bgm!.fadeInMs / 1000) * fps);
              const fadeOutFrames = Math.ceil((config.bgm!.fadeOutMs / 1000) * fps);
              const baseVolume = config.bgm!.volume;

              let vol = baseVolume;
              if (fadeInFrames > 0) {
                vol *= interpolate(f, [0, fadeInFrames], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
              }
              if (fadeOutFrames > 0) {
                vol *= interpolate(
                  f,
                  [total - fadeOutFrames, total],
                  [1, 0],
                  { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                );
              }
              return vol;
            }}
            loop
          />
        </Sequence>
      )}

      {/* Audio sequences */}
      {timeline.map(
        (entry, i) =>
          entry.segment.type === "speech" &&
          entry.segment.audioFile && (
            <Sequence
              key={i}
              from={entry.startFrame}
              durationInFrames={entry.segment.durationInFrames}
            >
              <Html5Audio src={staticFile(entry.segment.audioFile)} />
            </Sequence>
          )
      )}

      {/* Slide content */}
      {currentSlideMarkdown && (
        <SlideContent
          markdown={currentSlideMarkdown}
          fontFamily={slideFontFamily}
          codeHighlightTheme={config.codeHighlightTheme}
        />
      )}

      {/* Characters */}
      {config.characters.map((char) => (
        <CharacterDisplay
          key={char.name}
          isSpeaking={currentSpeechCharacter === char.name}
          imageSrc={`characters/${char.name}/default.png`}
          activeImageSrcs={char.activeImages?.map(
            (img) => `characters/${char.name}/${img}`
          )}
          position={char.position}
          flip={char.flip}
          overflowBottom={char.overflowY}
          overflowSide={char.overflowX}
          height={char.height}
        />
      ))}

      {/* Subtitle */}
      {currentSpeechText && (
        <Subtitle
          text={currentSpeechText}
          fontFamily={subtitleFontFamily}
          strokeColor={currentCharConfig?.color}
        />
      )}
    </AbsoluteFill>
  );
};
