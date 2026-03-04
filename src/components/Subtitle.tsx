import { loadDefaultJapaneseParser } from "budoux";
import React from "react";

interface Props {
  text: string;
  fontFamily: string;
  strokeColor?: string;
}

const DEFAULT_STROKE_COLOR = "#4a8a2a";
const STROKE_WIDTH = 14;

const parser = loadDefaultJapaneseParser();

/** BudouX で分割したセグメントを word-break: keep-all で折り返す */
const SegmentedText: React.FC<{ text: string }> = ({ text }) => {
  const segments = parser.parse(text);
  return (
    <span style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}>
      {segments.map((seg, i) => (
        <span key={i}>{seg}</span>
      ))}
    </span>
  );
};

/** Outlined text (袋文字) using paint-order: stroke fill */
export const Subtitle: React.FC<Props> = ({ text, fontFamily, strokeColor = DEFAULT_STROKE_COLOR }) => {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 40,
        left: 40,
        right: 40,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          fontSize: 64,
          fontWeight: 700,
          lineHeight: 1.5,
          maxWidth: "85%",
          textAlign: "center",
          fontFamily: `'${fontFamily}', sans-serif`,
          color: "#fff",
          WebkitTextStroke: `${STROKE_WIDTH}px ${strokeColor}`,
          paintOrder: "stroke fill",
        }}
      >
        <SegmentedText text={text} />

      </div >
    </div >
  );
};
