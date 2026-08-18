import { describe, expect, it } from "vitest";

import {
  decodePong,
  decodeResponse,
  decodeSnapshot,
  decodeTitleReason,
  HerdrError,
} from "./client.js";

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

describe("decodePong", () => {
  it("reads the version and protocol off a real pong", () => {
    const line =
      '{"id":"p1","result":{"type":"pong","version":"0.8.0","protocol":19,' +
      '"capabilities":{"live_handoff":true,"detached_server_daemon":true}}}';
    expect(decodePong(line)).toEqual({ version: "0.8.0", protocol: 19 });
  });

  it("rejects a pong that names no version, rather than inventing one", () => {
    expect(() => decodePong('{"id":"p1","result":{"type":"pong","protocol":19}}')).toThrow(
      HerdrError,
    );
  });
});

describe("decodeSnapshot", () => {
  it("reaches through the session_snapshot envelope", () => {
    const line =
      '{"id":"s","result":{"type":"session_snapshot","snapshot":{"protocol":19,"agents":[]}}}';
    expect(decodeSnapshot(line).protocol).toBe(19);
  });

  it("treats server_unavailable as a failure, though it is a well-formed response", () => {
    // The one failure that does not arrive as a socket error: herdr answers,
    // politely, that it cannot answer. A client that only watched the socket
    // would read this as a successful poll and hold a confident face over it.
    const line =
      '{"id":"s1","error":{"code":"server_unavailable","message":"herdr server is unavailable"}}';
    expect(() => decodeSnapshot(line)).toThrow(HerdrError);
    expect(() => decodeSnapshot(line)).toThrow(/unavailable/);
  });

  it("rejects a result that carries no snapshot", () => {
    expect(() => decodeSnapshot('{"id":"s","result":{"type":"session_snapshot"}}')).toThrow(
      /no snapshot/,
    );
  });
});

describe("decodeTitleReason", () => {
  it("reads back the reason herdr gives, not just the absence of an error", () => {
    expect(
      decodeTitleReason(
        '{"id":"t","result":{"type":"client_window_title","changed":true,"reason":"set"}}',
      ),
    ).toBe("set");
  });

  it("surfaces no_foreground_client, which is a successful response that did nothing", () => {
    // herdr is telling us there is no attached terminal to raise. It is not an
    // error, and it is the one free liveness signal in the press.
    expect(
      decodeTitleReason(
        '{"id":"t","result":{"type":"client_window_title","changed":false,"reason":"no_foreground_client"}}',
      ),
    ).toBe("no_foreground_client");
  });

  it("refuses to guess when the reason is missing or unrecognised", () => {
    // Reading a reason it does not know as no_foreground_client would report
    // "no terminal is attached" about a call that may well have worked.
    expect(() =>
      decodeTitleReason('{"id":"t","result":{"type":"client_window_title","changed":true}}'),
    ).toThrow(HerdrError);
    expect(() =>
      decodeTitleReason(
        '{"id":"t","result":{"type":"client_window_title","changed":true,"reason":"rewritten"}}',
      ),
    ).toThrow(/unknown reason/);
  });

  it("refuses an empty title at the call site, as herdr does on the wire", () => {
    // Verified server behaviour: `title: ""` is invalid_params; clearing has
    // its own method.
    expect(() =>
      decodeTitleReason(
        '{"id":"t","error":{"code":"invalid_params","message":"window title is empty"}}',
      ),
    ).toThrow(HerdrError);
  });
});
