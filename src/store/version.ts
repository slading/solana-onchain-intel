/**
 * Store format and derivation semantics versions (Milestone 5.1).
 *
 * Two different things change over time, and they are versioned separately:
 *
 *  - **`STORE_FORMAT_VERSION`** — the shape of the database (tables, columns, rules).
 *    It changes only when a migration is required, and the store refuses to open a file
 *    written by a different format version rather than guessing (M5.1 has no migration
 *    framework, and pretending to have one would be worse than failing loudly).
 *
 *  - **`DERIVED_SEMANTICS_VERSION`** — which semantic engine produced the artifacts in
 *    the `derived` table. It changes when any of the layers below can produce different
 *    output for the same raw evidence: the M2 decoder (`decoded`, inside `normalized`),
 *    the M3 effects layer, the M4.x swap recognizers or the M4.4 route envelope.
 *
 * The rule that makes re-analysis possible:
 *
 * ```
 * same stored raw evidence
 *   + newer semantic engine (a new DERIVED_SEMANTICS_VERSION)
 *   -> new `derived` rows, under the new version
 *   -> the raw evidence is never touched
 * ```
 *
 * Rows under older versions stay in the table (they are a history of what the engine used
 * to say) and are reported as stale; nothing ever serves them as current. `reanalyze`
 * replaces rows for the current version; `--prune` deletes the rest.
 *
 * **Bumping discipline.** Adding, removing or changing a recognizer must bump this
 * constant in the same commit. `tests/store.semantics-version.test.ts` computes a
 * fingerprint of all the layers' output over the frozen 13-fixture corpus and fails when
 * that output changed without the constant changing with it — so the bump cannot be
 * forgotten silently.
 */
export const STORE_FORMAT_VERSION = 1;

/**
 * Version of the canonical evidence codec (`src/store/codec.ts`).
 *
 * Recorded in `store_meta` and on every stored raw response, because `raw_sha256` is only a
 * meaningful "unchanged" signal *within* one codec: changing how a value is encoded changes
 * the bytes of the same payload. A store written by a different codec version is therefore
 * refused at open, rather than having its hashes silently compared against new ones.
 */
export const CODEC_VERSION = 1;

/**
 * M1 normalization + M2 decode + M3 effects + M4.1–M4.4 protocol semantics.
 *
 * The value names the engines that produced an artifact, so a row in `derived` can be
 * read by a human without consulting the store's code.
 */
export const DERIVED_SEMANTICS_VERSION = 'm1+m2+m3+m4.1+m4.2+m4.3+m4.4';

/** The artifact layers the store keeps, one row per (signature, layer, version). */
export const DERIVED_LAYERS = ['normalized', 'effects', 'swaps', 'routes'] as const;

export type DerivedLayer = (typeof DERIVED_LAYERS)[number];

export function isDerivedLayer(value: string): value is DerivedLayer {
  return (DERIVED_LAYERS as readonly string[]).includes(value);
}
