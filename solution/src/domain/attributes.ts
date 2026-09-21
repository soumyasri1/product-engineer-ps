import { UnknownAttributeError } from "./errors.ts";
import { fold } from "./text.ts";

/**
 * Cardinality is the single most important field in this system.
 *
 * It answers "does a new value for this attribute *replace* the old one, or sit beside
 * it?" without any model judgement:
 *
 *   single  the subject can only have one at a time. A new value contradicts the old
 *           one, so the slot is a candidate for supersession.
 *   multi   the subject can have many. A new value is additive and contradicts nothing,
 *           so it is never a supersession candidate.
 *
 * Getting this wrong in either direction is the classic memory bug: treat `allergy` as
 * single and you silently forget that someone is allergic to two things; treat
 * `home_city` as multi and you confidently report two current cities.
 */
export type Cardinality = "single" | "multi";

export interface AttributeSpec {
  /** Stable machine key. Part of the slot key, so it must never be renamed casually. */
  readonly key: string;
  /** Human phrasing used in canonical text and in the inspector. */
  readonly label: string;
  readonly cardinality: Cardinality;
  /**
   * Vocabulary that means this attribute. Used both by the extractor (to recognise a
   * fact) and by the retriever (to score an attribute match). Kept in one place so the
   * two can never drift apart.
   */
  readonly aliases: readonly string[];
  /** Template for the memory's canonical text; `{value}` is substituted. */
  readonly template: string;
  /**
   * The same fact addressed to the person it is about ("You live in {value}").
   *
   * `template` is third person because a memory is a statement *about* a subject, which is
   * the right form for logs, the CLI and the chain view. Anything that talks *to* the user
   * needs the second person, and deriving one from the other means conjugating verbs -- so
   * both phrasings are simply declared here, next to each other.
   */
  readonly second: string;
  /**
   * Marks attributes whose values are personal enough that the production answer is
   * different from the exercise answer. See docs/DECISIONS.md.
   */
  readonly sensitive?: boolean;
}

const SPECS: readonly AttributeSpec[] = [
  // ---- single-valued: a new value contradicts the previous one -------------------
  {
    key: "home_city",
    label: "home city",
    cardinality: "single",
    aliases: ["city", "live", "lives", "living", "located", "location", "based", "reside", "hometown", "where"],
    template: "lives in {value}",
    second: "You live in {value}",
  },
  {
    key: "employer",
    label: "employer",
    cardinality: "single",
    aliases: ["employer", "company", "work", "works", "working", "job", "firm", "workplace"],
    template: "works at {value}",
    second: "You work at {value}",
  },
  {
    key: "job_title",
    label: "job title",
    cardinality: "single",
    aliases: ["title", "role", "position", "designation", "job"],
    template: "has the job title {value}",
    second: "Your job title is {value}",
  },
  {
    key: "preferred_name",
    label: "preferred name",
    cardinality: "single",
    aliases: ["name", "called", "call", "prefers", "nickname", "goes"],
    template: "prefers to be called {value}",
    second: "You prefer to be called {value}",
  },
  {
    key: "timezone",
    label: "time zone",
    cardinality: "single",
    aliases: ["timezone", "time", "zone", "tz", "offset"],
    template: "is in the {value} time zone",
    second: "You are in the {value} time zone",
  },
  {
    key: "phone_number",
    label: "phone number",
    cardinality: "single",
    aliases: ["phone", "number", "mobile", "cell", "contact"],
    template: "has the phone number {value}",
    second: "Your phone number is {value}",
    sensitive: true,
  },
  {
    key: "dietary_preference",
    label: "dietary preference",
    cardinality: "single",
    aliases: ["diet", "dietary", "eat", "eats", "eating", "vegetarian", "vegan", "food"],
    template: "follows a {value} diet",
    second: "You follow a {value} diet",
    sensitive: true,
  },
  {
    key: "work_mode",
    label: "work mode",
    cardinality: "single",
    aliases: ["remote", "office", "hybrid", "onsite", "wfh", "commute"],
    template: "works {value}",
    second: "You work {value}",
  },

  // ---- multi-valued: a new value is additive ------------------------------------
  {
    key: "allergy",
    label: "allergy",
    cardinality: "multi",
    aliases: ["allergy", "allergic", "allergies", "intolerant", "intolerance", "reaction"],
    template: "is allergic to {value}",
    second: "You are allergic to {value}",
    sensitive: true,
  },
  {
    key: "likes",
    label: "likes",
    cardinality: "multi",
    aliases: ["like", "likes", "loves", "enjoys", "enjoy", "favourite", "favorite", "fan"],
    template: "likes {value}",
    second: "You like {value}",
  },
  {
    key: "dislikes",
    label: "dislikes",
    cardinality: "multi",
    aliases: ["dislike", "dislikes", "hates", "hate", "avoids", "avoid"],
    template: "dislikes {value}",
    second: "You dislike {value}",
  },
  {
    key: "skill",
    label: "skill",
    cardinality: "multi",
    aliases: ["skill", "skills", "knows", "experienced", "proficient", "expertise", "language"],
    template: "is skilled in {value}",
    second: "You are skilled in {value}",
  },
  {
    key: "pet",
    label: "pet",
    cardinality: "multi",
    aliases: ["pet", "pets", "dog", "cat", "animal"],
    template: "has a pet named {value}",
    second: "You have a pet named {value}",
  },
  {
    key: "goal",
    label: "goal",
    cardinality: "multi",
    aliases: ["goal", "goals", "wants", "aiming", "plans", "learning", "learn"],
    template: "has the goal {value}",
    second: "Your goal is to {value}",
  },
  {
    key: "tool_preference",
    label: "tool preference",
    cardinality: "multi",
    aliases: ["tool", "editor", "uses", "prefers", "stack", "framework"],
    template: "prefers the tool {value}",
    second: "You prefer {value}",
  },
];

const BY_KEY = new Map(SPECS.map((spec) => [spec.key, spec]));

/**
 * Alias -> attribute keys.
 *
 * One alias can legitimately point at several attributes ("job" means both employer and
 * job_title), so retrieval scores every candidate rather than guessing one.
 *
 * Every alias is indexed under both its literal form and its folded form, so a question
 * phrased in the other number ("what languages do I know" against the alias "knows") still
 * reaches the attribute.
 */
const BY_ALIAS = ((): ReadonlyMap<string, readonly string[]> => {
  const index = new Map<string, string[]>();

  const add = (rawKey: string, attribute: string): void => {
    const key = rawKey.toLowerCase();
    if (key.length === 0) return;
    const existing = index.get(key);
    if (existing) {
      if (!existing.includes(attribute)) existing.push(attribute);
    } else {
      index.set(key, [attribute]);
    }
  };

  for (const spec of SPECS) {
    for (const alias of [...spec.aliases, ...spec.label.split(" "), spec.key]) {
      add(alias, spec.key);
      add(fold(alias), spec.key);
    }
  }
  return index;
})();

export function allAttributes(): readonly AttributeSpec[] {
  return SPECS;
}

export function findAttribute(key: string): AttributeSpec | undefined {
  return BY_KEY.get(key);
}

export function requireAttribute(key: string): AttributeSpec {
  const spec = BY_KEY.get(key);
  if (!spec) throw new UnknownAttributeError(key);
  return spec;
}

/** Attribute keys that the given token could be referring to. */
export function attributesForToken(token: string): readonly string[] {
  return BY_ALIAS.get(token.toLowerCase()) ?? [];
}

export function canonicalText(attribute: string, value: string): string {
  return requireAttribute(attribute).template.replace("{value}", value);
}

/** The same fact phrased to the person it is about, for anything user-facing. */
export function secondPersonText(attribute: string, value: string): string {
  return requireAttribute(attribute).second.replace("{value}", value);
}

/**
 * The supersession slot. Two memories compete for currency only if they share a slot,
 * and only single-valued attributes form a contended slot.
 */
export function slotKey(subject: string, attribute: string): string {
  return `${normalizeSubject(subject)}::${attribute}`;
}

export function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase();
}

/**
 * Comparison form for values. Case and surrounding punctuation are noise; anything else
 * is a genuinely different value. Deliberately conservative -- we would rather flag two
 * spellings as a contradiction than merge two real facts.
 */
export function normalizeValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}
