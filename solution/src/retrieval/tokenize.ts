import { tokensMatch } from "../domain/text.ts";

/**
 * Tokenisation used by both scoring and query parsing.
 *
 * There are no embeddings here, by design. A lexical scorer can explain itself: every
 * point in a result's score traces to a token in a named field. An embedding score cannot
 * be defended in a review, and this problem is explicitly about being able to say why a
 * memory was returned.
 */

/**
 * Words that carry no retrieval signal. Short on purpose -- an aggressive stop list
 * silently deletes meaning ("do I like tea" would lose "like", which names an attribute).
 */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am",
  "do", "does", "did", "of", "to", "and", "or", "if", "it", "its",
  "on", "at", "by", "as", "from", "with", "about", "than", "then",
  "what", "which", "who", "whom", "how", "why", "tell", "me", "my",
  "i", "you", "your", "user", "s",
]);

export function tokenize(input: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const raw of input.toLowerCase().split(/[^\p{L}\p{N}+#]+/u)) {
    const token = raw.replace(/^'+|'+$/g, "");
    if (token.length === 0) continue;
    if (token.length < 2 && !/^\p{N}$/u.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}

/** True when `needle` matches any token in `haystack`. */
export function matchesIn(needle: string, haystack: readonly string[]): boolean {
  return haystack.some((token) => tokensMatch(needle, token));
}
