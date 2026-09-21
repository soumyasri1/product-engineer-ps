import type { Cardinality } from "./attributes.ts";
import type { Lifecycle } from "./lifecycle.ts";

/** A message in the conversation. Memories exist only as claims *about* a message. */
export interface SourceMessage {
  readonly id: string;
  readonly author: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

/**
 * Why we believe a memory. Every memory carries an unbroken path back to the exact
 * message and the exact span of text it was read from, plus the name of the rule that
 * read it. A memory that cannot be traced is a rumour, so provenance is non-optional.
 */
export interface Provenance {
  readonly messageId: string;
  /** The span of the source message the value was taken from. */
  readonly excerpt: string;
  /** Character offset of `excerpt` within the source message, or -1 if unlocatable. */
  readonly excerptOffset: number;
  /** Name of the extraction rule, or `manual` for directly asserted facts. */
  readonly rule: string;
  /** 0..1. Rule-assigned, not model-assigned: the same input always yields the same value. */
  readonly confidence: number;
}

export interface Memory {
  readonly id: string;

  // ---- the fact itself ----------------------------------------------------------
  readonly subject: string;
  readonly attribute: string;
  readonly value: string;
  /** Normalized `value`, used for equality. Stored so the DB can index it. */
  readonly valueKey: string;
  /** Rendered sentence, e.g. "lives in Mumbai". What retrieval hands to a caller. */
  readonly canonicalText: string;
  /** `subject::attribute`. Memories contend for currency only within a slot. */
  readonly slotKey: string;
  readonly cardinality: Cardinality;

  // ---- lifecycle ----------------------------------------------------------------
  readonly state: Lifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when this memory was replaced. Points forward along the chain. */
  readonly supersededBy: string | null;
  /** Set when this memory replaced another. Points backward along the chain. */
  readonly supersedes: string | null;
  readonly supersededAt: string | null;
  readonly deletedAt: string | null;
  /** `soft` keeps the value inspectable; `purged` destroys it and keeps a tombstone. */
  readonly deleteMode: "soft" | "purged" | null;

  readonly provenance: Provenance;
}

/**
 * An unresolved disagreement between two memories in the same single-valued slot.
 *
 * Conflicts are deliberately *not* a lifecycle state. A contradiction we are unsure
 * about must not quietly change what is current, so both memories stay `active` and the
 * conflict is recorded beside them. Retrieval then surfaces them as contested rather
 * than picking a winner it has no grounds to pick.
 */
export interface Conflict {
  readonly id: string;
  readonly slotKey: string;
  /** The older memory. */
  readonly memoryA: string;
  /** The newer memory. */
  readonly memoryB: string;
  readonly reason: string;
  readonly status: "open" | "resolved";
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  /** The memory that settled the conflict, once a later explicit correction arrives. */
  readonly resolvedByMemory: string | null;
}

/** One appended row per lifecycle change. The reason a memory is in its state. */
export interface AuditEntry {
  readonly seq: number;
  readonly memoryId: string;
  readonly fromState: Lifecycle | null;
  readonly toState: Lifecycle;
  readonly reason: string;
  readonly at: string;
}

// ---------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------

/** The fields a match can land in. Reported so a caller can see *why* a memory scored. */
export type MatchedField = "attribute" | "subject" | "value" | "canonicalText";

export interface ScoreComponent {
  readonly field: MatchedField;
  /** The query tokens that matched in this field. */
  readonly tokens: readonly string[];
  readonly weight: number;
  readonly points: number;
  readonly rule: string;
}

/**
 * The full, human-readable case for including a memory. Nothing in here is opaque: the
 * total is the sum of `components`, and each component names the rule that produced it.
 */
export interface RetrievalEvidence {
  readonly score: number;
  readonly matchedFields: readonly MatchedField[];
  readonly matchedTokens: readonly string[];
  readonly components: readonly ScoreComponent[];
  /** One-line summary of the decisive rule, for logs and the inspector. */
  readonly rule: string;
}

export interface RetrievedMemory {
  readonly memory: Memory;
  readonly evidence: RetrievalEvidence;
  /** Open conflict ids touching this memory. Non-empty means "do not trust alone". */
  readonly contestedBy: readonly string[];
}

/** Why a memory that matched the query was nonetheless left out. */
export type ExclusionReason =
  | "superseded"
  | "deleted"
  | "below-score-floor"
  | "beyond-limit";

export interface ExcludedMemory {
  readonly memoryId: string;
  readonly canonicalText: string;
  readonly reason: ExclusionReason;
  readonly score: number;
  /** For `superseded`, the memory that replaced it. */
  readonly supersededBy: string | null;
}

export interface RetrievalResult {
  readonly query: string;
  readonly queryTokens: readonly string[];
  readonly results: readonly RetrievedMemory[];
  /**
   * Candidates that scored above the floor but were withheld. This is the audit trail
   * that proves a stale fact was considered and rejected, rather than never seen.
   */
  readonly excluded: readonly ExcludedMemory[];
  readonly limit: number;
  readonly scoreFloor: number;
  /** True when at least one returned memory has an open conflict. */
  readonly hasContested: boolean;
}
