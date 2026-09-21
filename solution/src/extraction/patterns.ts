/**
 * Deterministic extraction rules.
 *
 * This layer is intentionally small and dumb. Extraction is not what the exercise is
 * about, and a model here would make every downstream assertion untestable. A named regex
 * gives three things a model would not: the same output for the same input forever, a
 * rule name that can be written into provenance, and a confidence we chose rather than one
 * we have to trust.
 *
 * The cost is honest coverage: phrasings outside these rules are simply not extracted.
 * The CLI's `remember` command exists so a fact can always be asserted directly.
 */

/**
 * A value that stops at the end of its clause.
 *
 * Without the lookahead, "I live in Mumbai and I work at Acme" yields the home city
 * "Mumbai and I work at Acme" -- the single most common way a regex extractor quietly
 * corrupts a store.
 */
const VALUE = String.raw`([^,.;!?\n]+?)(?=\s+(?:and|but|also|though|however|although|because|since|so|while|when|which|that|at|for)\b|[,.;!?\n]|$)`;

/**
 * Like VALUE but keeps commas and "and", so a list can be split into several facts.
 *
 * "and" cannot simply be a terminator here -- that is what makes "peanuts and shellfish" two
 * allergies. But "and" also joins *clauses*, and an unguarded list happily swallows the next
 * one: "I'm allergic to dust and I'm learning Elixir" produced the allergy
 * "I'm learning Elixir". The discriminator is what follows the "and" -- a subject pronoun
 * starts a new clause, anything else continues the list.
 */
const LIST = String.raw`([^.;!?\n]+?)(?=\s+and\s+(?:I|we|they|he|she|my|our|their|his|her)\b|\s+(?:but|though|however|although|because|since|so|while|when|which)\b|[.;!?\n]|$)`;

export interface ExtractionRule {
  /** Written verbatim into `Provenance.rule`. */
  readonly name: string;
  readonly attribute: string;
  readonly pattern: RegExp;
  readonly confidence: number;
  /**
   * Higher wins when two rules claim overlapping text. Prevents "I prefer to be called
   * Sam" from also registering a tool preference of "to be called Sam".
   */
  readonly priority: number;
  /** Split the capture into several values on commas and "and". */
  readonly list?: boolean;
  /** Replaces the captured text with a fixed value (for enumerated attributes). */
  readonly normalise?: (captured: string) => string;
}

export const RULES: readonly ExtractionRule[] = [
  // ---- preferred_name: must outrank the looser "I prefer ..." tool rule -----------
  {
    name: "preferred-name/call-me",
    attribute: "preferred_name",
    pattern: new RegExp(String.raw`\b(?:call me|I go by|I prefer to be called|I'd like to be called)\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 100,
  },
  {
    name: "preferred-name/my-name-is",
    attribute: "preferred_name",
    pattern: new RegExp(String.raw`\bmy name(?:'s| is)\s+${VALUE}`, "i"),
    confidence: 0.85,
    priority: 95,
  },

  // ---- home_city -----------------------------------------------------------------
  {
    name: "home-city/live-in",
    attribute: "home_city",
    pattern: new RegExp(String.raw`\bI(?:'m| am)?\s*(?:now\s+)?(?:live|living|reside|residing)\s+in\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 90,
  },
  {
    name: "home-city/moved-to",
    attribute: "home_city",
    pattern: new RegExp(String.raw`\bI(?:'ve| have)?\s*(?:just\s+)?(?:moved|relocated|move)\s+(?:back\s+)?to\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 90,
  },
  {
    name: "home-city/based-in",
    attribute: "home_city",
    pattern: new RegExp(String.raw`\bI(?:'m| am)\s+(?:now\s+)?(?:based|located)\s+in\s+${VALUE}`, "i"),
    confidence: 0.85,
    priority: 90,
  },
  {
    name: "home-city/my-city-is",
    attribute: "home_city",
    pattern: new RegExp(String.raw`\bmy\s+(?:home\s+)?city(?:'s| is)\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 90,
  },

  // ---- employer ------------------------------------------------------------------
  {
    name: "employer/work-at",
    attribute: "employer",
    pattern: new RegExp(String.raw`\bI\s+(?:now\s+)?work\s+(?:at|for)\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 85,
  },
  {
    name: "employer/joined",
    attribute: "employer",
    pattern: new RegExp(String.raw`\bI(?:'ve| have)?\s*(?:just\s+)?joined\s+${VALUE}`, "i"),
    confidence: 0.85,
    priority: 85,
  },
  {
    name: "employer/my-employer-is",
    attribute: "employer",
    pattern: new RegExp(String.raw`\bmy\s+(?:employer|company)(?:'s| is)\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 85,
  },
  {
    // "I work as a designer at Acme" carries two facts. The job-title rule claims the
    // tighter span and this one claims the wider one; overlap resolution keeps both
    // because neither contains the other's span.
    name: "employer/work-as-at",
    attribute: "employer",
    pattern: new RegExp(String.raw`\bI\s+(?:now\s+)?work\s+as\s+(?:a|an)\s+[^,.;!?\n]+?\s+(?:at|for)\s+${VALUE}`, "i"),
    confidence: 0.85,
    priority: 86,
  },

  // ---- job_title -----------------------------------------------------------------
  {
    name: "job-title/my-title-is",
    attribute: "job_title",
    pattern: new RegExp(String.raw`\bmy\s+(?:job\s+)?title(?:'s| is)\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 84,
  },
  {
    name: "job-title/work-as",
    attribute: "job_title",
    pattern: new RegExp(String.raw`\bI\s+(?:now\s+)?work\s+as\s+(?:a|an)\s+${VALUE}`, "i"),
    confidence: 0.85,
    priority: 86, // above employer/work-at, which would otherwise claim the same text
  },
  {
    name: "job-title/promoted-to",
    attribute: "job_title",
    pattern: new RegExp(String.raw`\bI(?:'ve| have)?\s*(?:been\s+)?(?:promoted|moved up)\s+to\s+(?:a\s+|an\s+)?${VALUE}`, "i"),
    confidence: 0.85,
    priority: 84,
  },

  // ---- timezone ------------------------------------------------------------------
  {
    name: "timezone/my-timezone-is",
    attribute: "timezone",
    pattern: new RegExp(String.raw`\bmy\s+time\s?zone(?:'s| is)\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 80,
  },

  // ---- phone_number --------------------------------------------------------------
  {
    name: "phone/my-number-is",
    attribute: "phone_number",
    pattern: /\bmy\s+(?:phone|mobile|cell|contact)?\s*number(?:'s| is)\s+([+\d][\d\s-]{6,}\d)/i,
    confidence: 0.95,
    priority: 80,
  },

  // ---- dietary_preference --------------------------------------------------------
  {
    name: "diet/i-am-a",
    attribute: "dietary_preference",
    pattern: /\bI(?:'m| am)\s+(?:a\s+|an\s+)?(vegetarian|vegan|pescatarian|omnivore|carnivore)\b/i,
    confidence: 0.9,
    priority: 80,
    normalise: (captured) => captured.toLowerCase(),
  },
  {
    name: "diet/follow-diet",
    attribute: "dietary_preference",
    pattern: new RegExp(String.raw`\bI\s+(?:follow|eat)\s+(?:a\s+|an\s+)?([\w -]+?)\s+diet`, "i"),
    confidence: 0.85,
    priority: 80,
  },

  // ---- work_mode -----------------------------------------------------------------
  {
    name: "work-mode/i-work",
    attribute: "work_mode",
    pattern: /\bI\s+(?:now\s+)?work\s+(remotely|remote|from home|hybrid|onsite|on site|in the office)\b/i,
    confidence: 0.85,
    priority: 87, // above employer/work-at so "I work remotely" is not an employer
    normalise: (captured) => {
      const value = captured.toLowerCase();
      if (value === "remote" || value === "from home") return "remotely";
      if (value === "on site") return "onsite";
      return value;
    },
  },

  // ---- allergy (multi) -----------------------------------------------------------
  {
    name: "allergy/allergic-to",
    attribute: "allergy",
    pattern: new RegExp(String.raw`\bI(?:'m| am)\s+allergic\s+to\s+${LIST}`, "i"),
    confidence: 0.9,
    priority: 75,
    list: true,
  },
  {
    name: "allergy/have-allergy",
    attribute: "allergy",
    pattern: new RegExp(String.raw`\bI\s+have\s+(?:a|an)\s+([\w -]+?)\s+allergy`, "i"),
    confidence: 0.85,
    priority: 75,
  },

  // ---- pet (multi) ---------------------------------------------------------------
  {
    name: "pet/named",
    attribute: "pet",
    pattern: new RegExp(String.raw`\b(?:my|I have a)\s+(?:dog|cat|pet|rabbit)\s+(?:is\s+)?(?:called|named)\s+${VALUE}`, "i"),
    confidence: 0.9,
    priority: 75,
  },

  // ---- skill (multi) -------------------------------------------------------------
  {
    name: "skill/proficient-in",
    attribute: "skill",
    pattern: new RegExp(String.raw`\bI(?:'m| am)\s+(?:skilled|proficient|experienced|fluent)\s+(?:in|with)\s+${LIST}`, "i"),
    confidence: 0.85,
    priority: 70,
    list: true,
  },

  // ---- goal (multi) --------------------------------------------------------------
  {
    name: "goal/learning",
    attribute: "goal",
    pattern: new RegExp(String.raw`\bI(?:'m| am)\s+(?:learning|studying)\s+${LIST}`, "i"),
    confidence: 0.8,
    priority: 70,
    list: true,
    normalise: (captured) => `learn ${captured}`,
  },
  {
    name: "goal/want-to",
    attribute: "goal",
    pattern: new RegExp(String.raw`\bI\s+want\s+to\s+${VALUE}`, "i"),
    confidence: 0.7,
    priority: 65,
  },

  // ---- likes / dislikes (multi) --------------------------------------------------
  {
    name: "dislikes/dislike",
    attribute: "dislikes",
    pattern: new RegExp(String.raw`\bI\s+(?:dislike|hate|can't stand|cannot stand)\s+${LIST}`, "i"),
    confidence: 0.8,
    priority: 62,
    list: true,
  },
  {
    name: "likes/like",
    attribute: "likes",
    pattern: new RegExp(String.raw`\bI\s+(?:like|love|enjoy)\s+${LIST}`, "i"),
    confidence: 0.8,
    priority: 60,
    list: true,
  },
  {
    name: "likes/favourite",
    attribute: "likes",
    pattern: new RegExp(String.raw`\bmy\s+favou?rite\s+\w+(?:'s| is)\s+${VALUE}`, "i"),
    confidence: 0.8,
    priority: 60,
  },

  // ---- tool_preference (multi): loosest rules, so lowest priority ----------------
  {
    name: "tool/i-use",
    attribute: "tool_preference",
    pattern: new RegExp(String.raw`\bI\s+use\s+${LIST}`, "i"),
    confidence: 0.7,
    priority: 50,
    list: true,
  },
  {
    name: "tool/i-prefer",
    attribute: "tool_preference",
    pattern: new RegExp(String.raw`\bI\s+prefer\s+${LIST}`, "i"),
    confidence: 0.7,
    priority: 50,
    list: true,
  },
];

/**
 * Phrases that mean "the thing I told you before is wrong".
 *
 * Their presence is what separates a correction (which supersedes) from a bare
 * contradiction (which does not). The list is closed and inspectable on purpose: the
 * alternative is a judgement call, and a judgement call is exactly what must not silently
 * delete someone's data.
 */
export const CORRECTION_MARKERS: readonly string[] = [
  "actually",
  "correction",
  "to correct",
  "i was wrong",
  "i misspoke",
  "scratch that",
  "disregard that",
  "ignore that",
  "update:",
  "no longer",
  "not anymore",
  "not any more",
  "instead of",
  "i've moved",
  "i have moved",
  "i moved",
  "i've relocated",
  "i relocated",
  "i've switched",
  "i switched",
  "i've changed",
  "i changed",
  "has changed",
  "changed to",
  "new number is",
  "as of today",
  "from now on",
  "i've left",
  "i have left",
  "i left",
  "i quit",
  // A promotion states a change of title rather than an additional one, so it carries the
  // same authority as "actually" for the job_title slot.
  "promoted to",
  "moved up to",
];

/** Correction markers present in `text`, lowercased, in the order this list declares. */
export function findCorrectionMarkers(body: string): string[] {
  const haystack = body.toLowerCase();
  return CORRECTION_MARKERS.filter((marker) => haystack.includes(marker));
}
