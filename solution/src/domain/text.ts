/**
 * Text normalisation primitives shared by the attribute registry and the retriever.
 *
 * They live in the domain rather than in the retrieval layer because folding has to be
 * applied to *both* sides of every comparison. When only the query side was folded, the
 * alias "knows" was unreachable from the question "what languages do I know" -- the kind of
 * asymmetry that is invisible until a fixture catches it.
 */

/**
 * Crude English plural folding. Deliberately not a stemmer: a stemmer is a dependency and
 * a source of surprises, and folding can only ever add matches, never move one to a
 * different field.
 */
export function fold(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

/** True when two tokens are equal, or equal once folded. */
export function tokensMatch(a: string, b: string): boolean {
  return a === b || fold(a) === fold(b);
}
