import { normalizeLanguageTag } from "../conversation-languages.mjs";
import { requireCondition as need } from "./errors.mjs";

export const maxIntroCaptionBytes = 16_384;
const timestamp = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
const cueTiming = /^(\S+)[\t ]+-->[\t ]+(\S+)(?:[\t ]+[^\n]*)?$/;
const controlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function milliseconds(value) {
  const pieces = timestamp.exec(value);
  if (!pieces) return Infinity;
  const [, hours, minutes, seconds, fraction] = pieces;
  return (((Number(hours || 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000) + Number(fraction);
}

export function normalizeIntroCaptions(input, durationSeconds) {
  if (input == null) return null;
  const language = normalizeLanguageTag(input.language);
  need(
    typeof input.text === "string" && input.text.length <= maxIntroCaptionBytes && language,
    "INVALID_CAPTIONS",
    "Choose a WebVTT file under 16 KiB and a valid caption language.",
    400,
  );
  const text = input.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd();
  const track = text + "\n";
  const sections = text.split(/\n(?:[\t ]*\n)+/);
  const header = sections.shift();
  need(
    new TextEncoder().encode(track).byteLength <= maxIntroCaptionBytes &&
      !controlCharacters.test(text) && /^WEBVTT(?:[\t ][^\n]*)?$/.test(header) &&
      !header.includes("-->") && sections.length > 0 && sections.length <= 100,
    "INVALID_CAPTIONS",
    "Provide a WebVTT file with timestamped cues and readable captions.",
    400,
  );
  let previous = 0;
  for (const section of sections) {
    const lines = section.split("\n");
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    const timing = cueTiming.exec(lines[timingIndex]);
    const start = timing ? milliseconds(timing[1]) : Infinity;
    const end = timing ? milliseconds(timing[2]) : Infinity;
    need(
      start >= previous && start < end && end <= durationSeconds * 1000 &&
        lines.slice(timingIndex + 1).some((line) => line.trim()),
      "INVALID_CAPTIONS",
      "Each WebVTT cue needs text and ordered timestamps within the clip.",
      400,
    );
    previous = start;
  }
  return { language, text: track };
}
