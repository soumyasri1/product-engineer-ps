import { attributesForToken, normalizeSubject } from "../domain/attributes.ts";
import type { Memory, MatchedField, RetrievalEvidence, ScoreComponent } from "../domain/types.ts";
import { fold, tokensMatch } from "../domain/text.ts";
import { matchesIn, tokenize } from "./tokenize.ts";

/**
 * Field weights.
 *
 * An attribute match is worth most because it is the strongest possible signal of intent:
 * asking "where do I live" names the `home_city` slot exactly, and should beat a memory
 * that merely happens to contain the word "live". A value match comes next, and the
 * rendered sentence last, since its wording is ours rather than the user's.
 */
export const WEIGHTS = {
  attribute: 3,
  value: 2,
  canonicalText: 1,
  subject: 0.5,
} as const satisfies Record<MatchedField, number>;

/** Below this, a match is coincidence rather than relevance. */
export const DEFAULT_SCORE_FLOOR = 1;

/** How many memories a caller gets at most. Retrieval must be bounded. */
export const DEFAULT_LIMIT = 5;

/**
 * Scores one memory against one query and shows its work.
 *
 * The returned total is exactly the sum of the component points -- there is no hidden term,
 * no normalisation and no randomness -- so the evidence a caller sees is the whole
 * calculation, not a summary of it.
 */
export function scoreMemory(memory: Memory, queryTokens: readonly string[]): RetrievalEvidence {
  const components: ScoreComponent[] = [];

  // 1. Does the query name this memory's attribute?
  //    Folded as well as exact, so "tools" reaches the "tool" alias and "allergies" the
  //    "allergy" one. Without this, a plural question silently drops to a weak
  //    canonical-text match and the strongest available signal is lost.
  const attributeTokens = queryTokens.filter((token) => {
    const direct = attributesForToken(token);
    if (direct.includes(memory.attribute)) return true;
    return attributesForToken(fold(token)).includes(memory.attribute);
  });
  if (attributeTokens.length > 0) {
    components.push({
      field: "attribute",
      tokens: attributeTokens,
      weight: WEIGHTS.attribute,
      points: attributeTokens.length * WEIGHTS.attribute,
      rule: `query names the "${memory.attribute}" attribute via its alias list`,
    });
  }

  // 2. Does the query mention the stored value?
  const valueTokens = tokenize(memory.value);
  const matchedValueTokens = queryTokens.filter((token) => matchesIn(token, valueTokens));
  if (matchedValueTokens.length > 0) {
    components.push({
      field: "value",
      tokens: matchedValueTokens,
      weight: WEIGHTS.value,
      points: matchedValueTokens.length * WEIGHTS.value,
      rule: "query token appears in the stored value",
    });
  }

  // 3. Anything left that appears in the rendered sentence. Tokens already credited above
  //    are not counted twice; double counting would make the total impossible to explain.
  const alreadyCredited = new Set([...attributeTokens, ...matchedValueTokens]);
  const canonicalTokens = tokenize(memory.canonicalText);
  const matchedCanonical = queryTokens.filter(
    (token) => !alreadyCredited.has(token) && matchesIn(token, canonicalTokens),
  );
  if (matchedCanonical.length > 0) {
    components.push({
      field: "canonicalText",
      tokens: matchedCanonical,
      weight: WEIGHTS.canonicalText,
      points: matchedCanonical.length * WEIGHTS.canonicalText,
      rule: "query token appears in the canonical sentence",
    });
  }

  // 4. Subject, which matters only once this stops being single-tenant.
  const subjectTokens = queryTokens.filter((token) =>
    tokensMatch(token, normalizeSubject(memory.subject)),
  );
  if (subjectTokens.length > 0) {
    components.push({
      field: "subject",
      tokens: subjectTokens,
      weight: WEIGHTS.subject,
      points: subjectTokens.length * WEIGHTS.subject,
      rule: "query names the memory's subject",
    });
  }

  const score = round(components.reduce((total, part) => total + part.points, 0));
  const matchedTokens = dedupe(components.flatMap((part) => part.tokens));

  return {
    score,
    matchedFields: components.map((part) => part.field),
    matchedTokens,
    components,
    rule: describe(components),
  };
}

function describe(components: readonly ScoreComponent[]): string {
  if (components.length === 0) return "no query token matched any field";
  const decisive = components.reduce((best, part) => (part.points > best.points ? part : best));
  return `${decisive.rule} (+${round(decisive.points)} of the total)`;
}

/** Two decimal places, so scores compare and print identically on every platform. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function dedupe(tokens: readonly string[]): string[] {
  return [...new Set(tokens)];
}
