import { allAttributes } from "../domain/attributes.ts";
import type {
  AuditEntry,
  Conflict,
  Memory,
  RetrievalResult,
} from "../domain/types.ts";
import type { ReconcileOutcome } from "../reconciliation/reconciler.ts";

/** Plain ASCII output: no colour codes and no box characters, so it reads the same in
 * PowerShell, Windows Terminal, a CI log and a screen recording. */

const STATE_MARK: Record<Memory["state"], string> = {
  active: "*",
  superseded: "~",
  deleted: "x",
};

export function memoryLine(memory: Memory): string {
  return (
    `${STATE_MARK[memory.state]} ${memory.id}  ${memory.state.padEnd(10)} ` +
    `${memory.attribute.padEnd(19)} ${memory.canonicalText}`
  );
}

export function outcomeBlock(outcome: ReconcileOutcome): string {
  const lines = [
    `  [${outcome.decision}] ${outcome.memory.id}  ${outcome.memory.canonicalText}`,
    `      why: ${outcome.rationale}`,
  ];
  if (outcome.superseded.length > 0) {
    for (const memory of outcome.superseded) {
      lines.push(`      superseded: ${memory.id} ("${memory.value}")`);
    }
  }
  if (outcome.conflict) {
    lines.push(`      conflict: ${outcome.conflict.id} (open)`);
  }
  return lines.join("\n");
}

export function retrievalBlock(result: RetrievalResult, options: { why: boolean }): string {
  const lines: string[] = [];
  lines.push(`query   "${result.query}"`);
  lines.push(`tokens  [${result.queryTokens.join(", ")}]`);
  lines.push(`bounds  limit ${result.limit}, score floor ${result.scoreFloor}`);
  lines.push("");

  if (result.results.length === 0) {
    lines.push("  (no current memory matched)");
  }

  result.results.forEach((hit, index) => {
    lines.push(
      `  ${index + 1}. ${hit.memory.canonicalText}` +
        (hit.contestedBy.length > 0 ? `   [CONTESTED: ${hit.contestedBy.join(", ")}]` : ""),
    );
    lines.push(
      `     ${hit.memory.id}  score ${hit.evidence.score.toFixed(2)}  ` +
        `fields ${hit.evidence.matchedFields.join("+") || "none"}`,
    );
    lines.push(`     ${hit.evidence.rule}`);
    if (options.why) {
      for (const component of hit.evidence.components) {
        lines.push(
          `       + ${component.points.toFixed(2)}  ${component.field.padEnd(14)} ` +
            `[${component.tokens.join(", ")}]  ${component.rule}`,
        );
      }
      lines.push(
        `       = ${hit.evidence.score.toFixed(2)}  from message ${hit.memory.provenance.messageId} ` +
          `via rule "${hit.memory.provenance.rule}"`,
      );
    }
    lines.push("");
  });

  if (result.excluded.length > 0) {
    lines.push(`  considered and withheld (${result.excluded.length}):`);
    for (const item of result.excluded) {
      lines.push(
        `     - ${item.memoryId}  ${item.reason.padEnd(18)} score ${item.score.toFixed(2)}  ` +
          `${item.canonicalText}` +
          (item.supersededBy ? `  -> replaced by ${item.supersededBy}` : ""),
      );
    }
    lines.push("");
  }

  if (result.hasContested) {
    lines.push(
      "  NOTE: at least one answer is contested. The engine has two active values for a",
    );
    lines.push(
      "  single-valued attribute and no stated correction, so it will not choose between",
    );
    lines.push("  them. Use `mem conflicts` and `mem resolve` to settle it.");
    lines.push("");
  }

  return lines.join("\n");
}

export function auditBlock(entries: readonly AuditEntry[]): string {
  return entries
    .map(
      (entry) =>
        `     ${entry.at}  ${(entry.fromState ?? "(new)").padEnd(11)} -> ${entry.toState.padEnd(11)} ${entry.reason}`,
    )
    .join("\n");
}

export function conflictLine(conflict: Conflict): string {
  return (
    `${conflict.status === "open" ? "!" : "-"} ${conflict.id}  ${conflict.status.padEnd(9)} ` +
    `${conflict.slotKey}\n    ${conflict.memoryA} vs ${conflict.memoryB}\n    ${conflict.reason}` +
    (conflict.resolvedByMemory ? `\n    settled by ${conflict.resolvedByMemory}` : "")
  );
}

export function attributeTable(): string {
  return allAttributes()
    .map(
      (spec) =>
        `  ${spec.key.padEnd(20)} ${spec.cardinality.padEnd(7)} ` +
        `${spec.sensitive ? "sensitive" : "         "}  aliases: ${spec.aliases.join(", ")}`,
    )
    .join("\n");
}
