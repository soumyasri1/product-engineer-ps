import { canonicalText, normalizeValue, requireAttribute } from "../domain/attributes.ts";
import type { SourceMessage } from "../domain/types.ts";
import { findCorrectionMarkers, RULES, type ExtractionRule } from "./patterns.ts";

/** A fact a rule believes it found, before reconciliation decides what to do with it. */
export interface CandidateFact {
  readonly subject: string;
  readonly attribute: string;
  readonly value: string;
  readonly valueKey: string;
  readonly canonicalText: string;
  /** The span of source text the rule matched. Becomes `Provenance.excerpt`. */
  readonly excerpt: string;
  readonly excerptOffset: number;
  readonly rule: string;
  readonly confidence: number;
  /**
   * Correction phrases found in the *same sentence* as this fact.
   *
   * Sentence scope rather than message scope: in "Actually I'm allergic to shellfish, and
   * I live in Pune" the correction plainly refers to the allergy, and letting "actually"
   * also supersede the stored home city would destroy a fact the user never contradicted.
   */
  readonly correctionMarkers: readonly string[];
}

export interface ExtractionOutcome {
  readonly messageId: string;
  readonly facts: readonly CandidateFact[];
  /** Every correction phrase in the message, for reporting. Reconciliation uses the
   * per-fact list instead. */
  readonly correctionMarkers: readonly string[];
}

/** An accepted regex hit, before list values are expanded into individual facts. */
interface RuleMatch {
  readonly rule: ExtractionRule;
  readonly start: number;
  readonly end: number;
  /**
   * Offset of the captured value, which is not the same as `start`.
   *
   * "I work as a senior designer at Globex" is matched from position 0 by both the
   * job-title rule and the employer rule; only the value offsets distinguish them, and
   * ordering by value is what makes the extracted facts follow the sentence.
   */
  readonly valueStart: number;
  readonly excerpt: string;
  readonly captured: string;
}

export interface ExtractorOptions {
  /** Whose facts these are. Single-tenant here, but the slot key is already scoped. */
  readonly subject?: string;
}

/**
 * Turns a message into candidate facts.
 *
 * Extraction deliberately knows nothing about what is already stored. It reports what the
 * message says; deciding whether that supersedes, conflicts with, or merely adds to
 * existing knowledge is the reconciler's job. Keeping the two apart is what makes the
 * correction policy testable in isolation.
 */
export class Extractor {
  private readonly subject: string;

  constructor(options: ExtractorOptions = {}) {
    this.subject = options.subject ?? "user";
  }

  extract(message: SourceMessage): ExtractionOutcome {
    const matches = resolveOverlaps(collectMatches(message.text));
    const sentences = splitSentences(message.text);

    const facts: CandidateFact[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
      for (const raw of splitValues(match)) {
        const value = tidy(match.rule.normalise ? match.rule.normalise(raw) : raw);
        if (!isPlausibleValue(value)) continue;

        const valueKey = normalizeValue(value);
        const dedupeKey = `${match.rule.attribute}::${valueKey}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        requireAttribute(match.rule.attribute);

        facts.push({
          subject: this.subject,
          attribute: match.rule.attribute,
          value,
          valueKey,
          canonicalText: canonicalText(match.rule.attribute, value),
          excerpt: match.excerpt,
          excerptOffset: match.start,
          rule: match.rule.name,
          confidence: match.rule.confidence,
          correctionMarkers: findCorrectionMarkers(sentenceAt(sentences, match.start)),
        });
      }
    }

    // No sort here on purpose. `resolveOverlaps` already returns matches in a
    // deterministic order (by position, then rule name), and values within one match keep
    // the order they were written in. Facts therefore come out in reading order, which
    // makes the assigned ids follow the sentence -- and re-sorting by value would scramble
    // that for no gain in determinism.

    return {
      messageId: message.id,
      facts,
      correctionMarkers: findCorrectionMarkers(message.text),
    };
  }
}

interface Sentence {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Splits on sentence terminators, keeping offsets so a fact can be mapped back to the
 * sentence it came from. Clause separators (commas, "and") are not boundaries: a
 * correction and its replacement value routinely share one sentence.
 */
function splitSentences(body: string): Sentence[] {
  const sentences: Sentence[] = [];
  const boundary = /[.!?\n]+/g;
  let start = 0;
  let found: RegExpExecArray | null;

  while ((found = boundary.exec(body)) !== null) {
    const end = found.index + found[0].length;
    sentences.push({ start, end, text: body.slice(start, end) });
    start = end;
  }
  if (start < body.length) {
    sentences.push({ start, end: body.length, text: body.slice(start) });
  }

  return sentences.length > 0
    ? sentences
    : [{ start: 0, end: body.length, text: body }];
}

function sentenceAt(sentences: readonly Sentence[], offset: number): string {
  return sentences.find((s) => offset >= s.start && offset < s.end)?.text ?? "";
}

function collectMatches(body: string): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const rule of RULES) {
    const found = rule.pattern.exec(body);
    if (!found || found.index === undefined) continue;

    const captured = found[1];
    if (captured === undefined) continue;

    const withinMatch = found[0].indexOf(captured);

    matches.push({
      rule,
      start: found.index,
      end: found.index + found[0].length,
      valueStart: found.index + (withinMatch === -1 ? 0 : withinMatch),
      excerpt: found[0].trim(),
      captured,
    });
  }

  return matches;
}

/**
 * Keeps the most specific reading of each span.
 *
 * Sorted by priority, then by span length ascending so a tight match is considered before
 * a loose one that swallows it. A candidate is dropped when it is fully contained in an
 * already accepted span, or when it overlaps an accepted span for the same attribute.
 * Wider matches that add a *different* attribute survive, which is how "I work as a
 * designer at Acme" yields both a job title and an employer.
 */
function resolveOverlaps(matches: readonly RuleMatch[]): RuleMatch[] {
  const ordered = [...matches].sort(
    (a, b) =>
      b.rule.priority - a.rule.priority ||
      (a.end - a.start) - (b.end - b.start) ||
      a.start - b.start ||
      a.rule.name.localeCompare(b.rule.name),
  );

  const accepted: RuleMatch[] = [];

  for (const candidate of ordered) {
    const shadowed = accepted.some((existing) => {
      const containedInExisting =
        candidate.start >= existing.start && candidate.end <= existing.end;
      const overlaps = candidate.start < existing.end && existing.start < candidate.end;
      return containedInExisting || (overlaps && existing.rule.attribute === candidate.rule.attribute);
    });

    if (!shadowed) accepted.push(candidate);
  }

  return accepted.sort(
    (a, b) =>
      a.valueStart - b.valueStart ||
      a.start - b.start ||
      a.rule.name.localeCompare(b.rule.name),
  );
}

function splitValues(match: RuleMatch): string[] {
  if (!match.rule.list) return [match.captured];
  return match.captured
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function tidy(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/[\s,.;:!?]+$/, "");
}

/**
 * Cheap sanity gate. A rule that captured a whole clause, a bare pronoun, or nothing
 * useful should produce no memory at all rather than a memory nobody can interpret.
 */
function isPlausibleValue(value: string): boolean {
  if (value.length < 2 || value.length > 80) return false;
  if (!/[\p{L}\p{N}]/u.test(value)) return false;
  if (/^(?:it|that|this|them|those|these|there|here|me|you|my|his|her|their)$/i.test(value)) {
    return false;
  }
  // A value never begins with a subject pronoun -- that is a clause the pattern over-reached
  // into, not a thing the user has. Second line of defence behind the LIST guard.
  if (/^(?:i|we|they|he|she|you)\b/i.test(value)) return false;
  // More than eight words is a clause, not a value.
  return value.split(" ").length <= 8;
}
