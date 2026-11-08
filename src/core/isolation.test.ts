import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Where the policy and the face live: everything the backend seam keeps protocol-free. */
const DIRS = ["../core/", "../face/"];

describe("the backend seam", () => {
  it("keeps the core and the face from importing anything of herdr's", () => {
    for (const dir of DIRS) {
      const root = new URL(dir, import.meta.url);
      for (const file of readdirSync(root)) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
        const source = readFileSync(new URL(file, root), "utf8");
        const imports = source.split("\n").filter((line) => line.includes(" from "));
        expect({ file, herdr: imports.filter((line) => line.includes("/herdr/")) }).toEqual({
          file,
          herdr: [],
        });
      }
    }
  });
});
