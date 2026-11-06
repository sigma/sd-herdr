/**
 * Test-only access to the Rex corpus under `fixtures/rex/`, read off disk for
 * the same reason as the herdr one (`fixtures.ts`): what a test asserts against
 * is the file a reviewer opens.
 *
 * A Rex fixture is what the poll hands the conversion: the `session.view` and,
 * per terminal block, its status records and title.
 */
import { readFileSync } from "node:fs";

import type { Snapshot } from "../core/snapshot.js";
import { fromRex } from "../rex/convert.js";
import type { BlockReport, SessionView } from "../rex/view.js";
import type { Provenance } from "./fixtures.js";

export const REX_FIXTURE_NAMES = [
  "live-session",
  "two-windows",
  "split-tab",
  "floating-layer",
  "nested-records",
  "unnamed-multi-agent",
] as const;

export type RexFixtureName = (typeof REX_FIXTURE_NAMES)[number];

interface RexFixtureFile {
  readonly provenance: Provenance;
  readonly view: SessionView;
  readonly reports: Readonly<Record<string, BlockReport>>;
}

function read(name: RexFixtureName): RexFixtureFile {
  const path = new URL(`../../fixtures/rex/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as RexFixtureFile;
}

/** A fixture's view and reports, as the poll would hand them over. */
export function rexWire(name: RexFixtureName): {
  view: SessionView;
  reports: ReadonlyMap<string, BlockReport>;
} {
  const file = read(name);
  return { view: file.view, reports: new Map(Object.entries(file.reports)) };
}

/** A fixture converted into what the core reads. */
export function rexFixture(name: RexFixtureName): Snapshot {
  const { view, reports } = rexWire(name);
  return fromRex(view, reports, "instance:fixture");
}

export function rexProvenance(name: RexFixtureName): Provenance {
  return read(name).provenance;
}
