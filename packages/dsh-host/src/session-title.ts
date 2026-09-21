import type { SessionSummary } from "@gatherthread/bridge";

/**
 * DSH clips a Session title to this many UTF-8 bytes. The limit is DSH's default
 * `maxTitleBytes` (declared in `@deepseek-ai/dsh-base`'s `cordis.patch.yml`), and
 * DSH clips **silently, from the end** — so a title that overshoots loses its
 * tail, which is exactly where the GatherThread marker sits.
 *
 * Codex has the same hazard at a 240-**character** budget
 * (`managedCodexThreadName` in `@gatherthread/bridge`). The two do not share a
 * helper because the units differ: this one must clip by UTF-8 bytes, because a
 * Chinese session name costs three bytes per character.
 */
export const DSH_SESSION_TITLE_MAX_BYTES = 80;

/** The separator DSH titles use between the Session name and the marker. */
const SEPARATOR = " · ";

/**
 * Name one GatherThread-bound DSH Session so the session rail distinguishes it
 * from a plain local conversation.
 *
 * The Session name is clipped to whatever remains after the marker, so the
 * marker always survives DSH's own clipping and the result never exceeds the
 * budget. The marker also guarantees a non-empty title, which is the only thing
 * DSH's title service rejects.
 */
export function managedDshSessionTitle(
  session: Pick<SessionSummary, "id" | "name" | "mode">,
): string {
  const marker = `${markerBrand(session.mode)}`;
  const suffix = `${SEPARATOR}${marker}`;
  const budget = DSH_SESSION_TITLE_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  const name = clipToUtf8Bytes(session.name ?? session.id, budget);
  return name === "" ? marker : `${name}${suffix}`;
}

/**
 * The brand and, when it is known, the session type — matching the label Codex
 * tasks already carry so the two harnesses read the same way in a session list.
 */
function markerBrand(mode: unknown): string {
  return mode === "solo" || mode === "multi" ? `共序 · ${mode.toUpperCase()}` : "共序";
}

/**
 * Keep as much of `value` as fits `maxBytes`, iterating by code point so a
 * multi-byte character is never cut in half. An emoji costs four bytes and must
 * be dropped whole rather than becoming a replacement character.
 */
function clipToUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let kept = "";
  let used = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (used + size > maxBytes) break;
    kept += codePoint;
    used += size;
  }
  return kept;
}
