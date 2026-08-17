import { describe, expect, it } from "vitest";

import { decodeResponse, decodeSnapshot, HerdrError } from "./client.js";

/**
 * The socket itself is edge and is verified by hand against a live herdr. What
 * is tested here is the wire contract — the shapes herdr actually puts on the
 * line, taken from the responses recorded in `docs/research/herdr-socket-api.md`.
 */
describe("decodeResponse", () => {
  it("unwraps a result", () => {
    expect(decodeResponse('{"id":"p1","result":{"type":"pong","protocol":19}}')).toEqual({
      type: "pong",
      protocol: 19,
    });
  });

  it("turns an error response into a HerdrError carrying its code", () => {
    const line = '{"id":"p6","error":{"code":"pane_not_found","message":"pane wZZ:p99 not found"}}';
    expect(() => decodeResponse(line)).toThrow(HerdrError);
    try {
      decodeResponse(line);
    } catch (err) {
      expect((err as HerdrError).code).toBe("pane_not_found");
      expect((err as HerdrError).message).toBe("pane wZZ:p99 not found");
    }
  });

  it("rejects a line that is not JSON rather than returning undefined", () => {
    expect(() => decodeResponse("not json")).toThrow(HerdrError);
  });

  it("rejects an envelope with neither result nor error", () => {
    expect(() => decodeResponse('{"id":"x"}')).toThrow(/no result/);
  });

  it("does not correlate on id, which herdr does not echo back on a parse failure", () => {
    // Verified server behaviour: a malformed request comes back under id "".
    expect(() =>
      decodeResponse('{"id":"","error":{"code":"invalid_request","message":"bad"}}'),
    ).toThrow(/bad/);
  });
});

describe("decodeSnapshot", () => {
  it("reaches through the session_snapshot envelope", () => {
    const line =
      '{"id":"s","result":{"type":"session_snapshot","snapshot":{"protocol":19,"agents":[]}}}';
    expect(decodeSnapshot(line).protocol).toBe(19);
  });

  it("rejects a result that carries no snapshot", () => {
    expect(() => decodeSnapshot('{"id":"s","result":{"type":"session_snapshot"}}')).toThrow(
      /no snapshot/,
    );
  });
});
