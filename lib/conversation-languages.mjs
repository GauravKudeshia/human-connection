export const maxHostLanguages = 20;
export const languageProficiency = Object.freeze({
  conversational: "Conversational",
  fluent: "Fluent",
  bilingual: "Native or bilingual",
});

const names = new Intl.DisplayNames(["en"], {
  type: "language",
  fallback: "none",
});
const legacyTags = new Map([
  ["english", "en"],
  ["spanish", "es"],
]);

export function normalizeLanguageTag(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const input = value.trim();
  if (!input || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(input)) return null;
  try {
    const tag = Intl.getCanonicalLocales(
      legacyTags.get(input.toLowerCase()) || input,
    )[0];
    const locale = new Intl.Locale(tag);
    // Locale preferences and non-conversation identifiers do not describe a spoken language.
    const spoken =
      locale.baseName === tag &&
      !["und", "mul", "zxx"].includes(locale.language) &&
      names.of(locale.language);
    return spoken ? tag : null;
  } catch {
    return null;
  }
}

export function languageName(value) {
  const tag = normalizeLanguageTag(value);
  return tag ? names.of(tag) || tag : "";
}

// New host records use explicit selections. Existing English/Spanish strings
// retain their meaning and have no inferred proficiency.
export function normalizeHostLanguages(entries) {
  if (!Array.isArray(entries) || entries.length > maxHostLanguages) return null;
  const result = new Map();
  for (const entry of entries) {
    const tag = normalizeLanguageTag(
      typeof entry === "string" ? entry : entry?.tag,
    );
    const proficiency =
      typeof entry === "string" ? null : entry?.proficiency ?? null;
    if (
      !tag ||
      (proficiency !== null &&
        (typeof proficiency !== "string" ||
          !Object.hasOwn(languageProficiency, proficiency)))
    )
      return null;
    const previous = result.get(tag);
    if (!previous || (previous.proficiency === null && proficiency !== null))
      result.set(tag, { tag, proficiency });
  }
  return [...result.values()];
}

export function readHostLanguages(value) {
  try {
    const entries = typeof value === "string" ? JSON.parse(value) : value;
    return normalizeHostLanguages(entries) || [];
  } catch {
    return [];
  }
}
