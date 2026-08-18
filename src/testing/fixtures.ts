/**
 * Test-only access to the snapshot corpus under `fixtures/`.
 *
 * Fixtures are read off disk rather than imported, so that what a test asserts
 * against is byte-for-byte the file a reviewer opens — no bundler transform, no
 * chance of a type assertion quietly reshaping a captured snapshot.
 */
import { readFileSync } from "node:fs";

import type { Snapshot } from "../herdr/snapshot.js";

/** Every fixture in the corpus, for tests that sweep the whole thing. */
export const FIXTURE_NAMES = [
  "live-session",
  "blocked-one",
  "done-only",
  "mixed-tiers",
  "unknown-only",
  "no-agents",
  "split-tab",
  "done-pair",
  "done-pair-consumed",
  "done-pair-newcomer",
] as const;

/**
 * The corpus's fixture names, so a typo is a compile error rather than ENOENT.
 * Derived from the list above so the two cannot drift apart.
 */
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/**
 * Where a fixture came from. Carried inside the file rather than alongside it:
 * a captured snapshot is evidence about one installation, a derived one is a
 * statement of intent, and a reader needs to know which without leaving the
 * file.
 */
export interface Provenance {
  readonly kind: "captured" | "derived";
  readonly note: string;
  /** Captured only. */
  readonly capturedAt?: string;
  readonly subject?: string;
  readonly method?: string;
  /** Derived only. */
  readonly derivedFrom?: string;
  readonly shape?: string;
}

interface FixtureFile {
  readonly provenance: Provenance;
  readonly snapshot: Snapshot;
}

function read(name: FixtureName): FixtureFile {
  const path = new URL(`../../fixtures/snapshots/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
}

/** The snapshot held by a fixture. */
export function fixture(name: FixtureName): Snapshot {
  return read(name).snapshot;
}

/** A fixture's provenance block. */
export function provenance(name: FixtureName): Provenance {
  return read(name).provenance;
}
