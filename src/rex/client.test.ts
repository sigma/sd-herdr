import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  API_REVISION,
  type ControlSocket,
  Correlator,
  decodeMessage,
  helloFrame,
  RexControl,
  RexError,
} from "./client.js";

/**
 * The socket itself is edge and is verified by hand against a live Rex server.
 * What is tested here is the wire contract (decoding, id correlation, the
 * hello) and the connection's lifecycle, driven through a stand-in socket.
 */
describe("decodeMessage", () => {
  it("reads the welcome", () => {
    expect(
      decodeMessage('{"type":"welcome","protocol":"rex.control.v1","api_revision":11}'),
    ).toEqual({
      type: "welcome",
    });
  });

  it("reads a response's payload and id", () => {
    expect(decodeMessage('{"type":"response","id":"a1","seq":3,"payload":{"x":1}}')).toEqual({
      type: "response",
      id: "a1",
      payload: { x: 1 },
    });
  });

  it("reads an error response's code, not just its message", () => {
    const line =
      '{"type":"response","id":"a2","seq":4,"error":{"code":"session_not_found","message":"no such session","status":404}}';
    expect(decodeMessage(line)).toEqual({
      type: "response",
      id: "a2",
      error: { code: "session_not_found", message: "no such session" },
    });
  });

  it("gives an error with no code the code `unknown`", () => {
    const message = decodeMessage('{"type":"response","id":"a3","error":{}}');
    expect(message).toMatchObject({ error: { code: "unknown" } });
  });

  it("skips events and types it does not know", () => {
    expect(decodeMessage('{"type":"event","seq":1,"event":{}}')).toEqual({ type: "other" });
    expect(decodeMessage('{"type":"from-the-future"}')).toEqual({ type: "other" });
  });

  it("rejects a frame that is not JSON, or not an object, or a response without an id", () => {
    expect(() => decodeMessage("not json")).toThrow(RexError);
    expect(() => decodeMessage("[1]")).not.toThrow();
    expect(() => decodeMessage("null")).toThrow(RexError);
    expect(() => decodeMessage('{"type":"response"}')).toThrow(/without an id/);
  });
});

describe("helloFrame", () => {
  it("pins API revision 11 at both ends and says who is calling", () => {
    expect(API_REVISION).toBe(11);
    expect(JSON.parse(helloFrame("0.1.0.0"))).toEqual({
      type: "hello",
      api_revision: 11,
      api_min_revision: 11,
      client: { kind: "other", name: "sd-mux", version: "0.1.0.0" },
    });
  });
});

describe("Correlator", () => {
  it("frames a request with a string id", () => {
    const { id, frame } = new Correlator().open("session.view", { session_id: "s" });
    expect(typeof id).toBe("string");
    expect(JSON.parse(frame)).toEqual({
      type: "request",
      id,
      method: "session.view",
      payload: { session_id: "s" },
    });
  });

  it("matches responses to requests by id, whatever order they arrive in", async () => {
    const book = new Correlator();
    const first = book.open("a", {});
    const second = book.open("b", {});
    expect(first.id).not.toBe(second.id);

    book.receive({ type: "response", id: second.id, payload: "second" });
    book.receive({ type: "response", id: first.id, payload: "first" });
    expect(await first.result).toBe("first");
    expect(await second.result).toBe("second");
    expect(book.size).toBe(0);
  });

  it("rejects with the error's code, so a caller can branch on it", async () => {
    const book = new Correlator();
    const { id, result } = book.open("session.view", {});
    book.receive({ type: "response", id, error: { code: "session_not_found", message: "gone" } });
    await expect(result).rejects.toMatchObject({ name: "RexError", code: "session_not_found" });
  });

  it("drops a response nobody is waiting for, and anything that is not a response", async () => {
    const book = new Correlator();
    const { id, result } = book.open("a", {});
    book.receive({ type: "response", id: "stranger", payload: 1 });
    book.receive({ type: "other" });
    book.receive({ type: "welcome" });
    expect(book.size).toBe(1);
    book.receive({ type: "response", id, payload: "ok" });
    expect(await result).toBe("ok");
  });

  it("fails everything in flight when the connection goes", async () => {
    const book = new Correlator();
    const a = book.open("a", {});
    const b = book.open("b", {});
    book.failAll(new RexError("closed", "gone"));
    await expect(a.result).rejects.toMatchObject({ code: "closed" });
    await expect(b.result).rejects.toMatchObject({ code: "closed" });
    expect(book.size).toBe(0);
  });
});

/** A stand-in for the control socket that records what the client sends. */
class FakeSocket extends EventEmitter implements ControlSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  /** The server speaks. */
  say(message: object): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  /** The server answers the most recent request. */
  answer(payload: unknown): void {
    const last = this.sent[this.sent.length - 1];
    this.say({ type: "response", id: last?.id, seq: 1, payload });
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A client whose sockets are all FakeSockets, kept so a test can reach them. */
function harness() {
  const sockets: FakeSocket[] = [];
  const control = new RexControl(
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => "9.9.9",
  );
  return { control, sockets };
}

/** Walk a fresh socket through hello, welcome and attach. */
async function handshake(socket: FakeSocket, instanceId = "inst-1"): Promise<void> {
  socket.emit("open");
  await settle();
  expect(socket.sent[0]).toMatchObject({ type: "hello", api_revision: 11, api_min_revision: 11 });
  socket.say({ type: "welcome", protocol: "rex.control.v1", api_revision: 11 });
  await settle();
  expect(socket.sent[1]).toMatchObject({
    type: "request",
    method: "session.attach_all",
    payload: { event_scope: "session" },
  });
  socket.answer({});
  await settle();
  expect(socket.sent[2]).toMatchObject({ type: "request", method: "server.status" });
  socket.answer({ instance_id: instanceId });
  await settle();
}

describe("RexControl", () => {
  it("opens no connection until something asks, and none for a request with no tile", async () => {
    const { control, sockets } = harness();
    expect(control.connected).toBe(false);
    await expect(control.request("session.view", {})).rejects.toMatchObject({ code: "closed" });
    expect(sockets).toHaveLength(0);
  });

  it("says hello, waits for the welcome, and attaches before the first request goes out", async () => {
    const { control, sockets } = harness();
    control.retain();
    const result = control.request("session.view", { session_id: "s" });
    const socket = sockets[0] as FakeSocket;
    expect(socket.sent).toHaveLength(0); // nothing is sent before the socket opens

    await handshake(socket);
    expect(socket.sent[3]).toMatchObject({ method: "session.view", payload: { session_id: "s" } });
    socket.answer({ revision: 1 });
    expect(await result).toEqual({ revision: 1 });
  });

  it("shares one connection between concurrent requests", async () => {
    const { control, sockets } = harness();
    control.retain();
    const a = control.request("a", {});
    const b = control.request("b", {});
    expect(sockets).toHaveLength(1);
    await handshake(sockets[0] as FakeSocket);
    const socket = sockets[0] as FakeSocket;
    const ids = socket.sent.slice(3).map((m) => m.id);
    socket.say({ type: "response", id: ids[1], payload: "b" });
    socket.say({ type: "response", id: ids[0], payload: "a" });
    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });

  it("surfaces an error response with its code", async () => {
    const { control, sockets } = harness();
    control.retain();
    const result = control.request("session.view", {});
    const socket = sockets[0] as FakeSocket;
    await handshake(socket);
    const id = socket.sent[3]?.id;
    socket.say({ type: "response", id, error: { code: "session_not_found", message: "x" } });
    await expect(result).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("closes with a close frame when the last tile goes, and not before", async () => {
    const { control, sockets } = harness();
    const releaseA = control.retain();
    const releaseB = control.retain();
    const pending = control.request("a", {});
    const socket = sockets[0] as FakeSocket;
    await handshake(socket);
    socket.answer(1);
    await pending;

    releaseA();
    expect(socket.closed).toBe(false);
    releaseB();
    expect(socket.closed).toBe(true);
    expect(control.connected).toBe(false);
  });

  it("does not reopen for a poll that was in flight when the last tile went", async () => {
    const { control, sockets } = harness();
    const release = control.retain();
    const pending = control.request("a", {});
    const socket = sockets[0] as FakeSocket;
    await handshake(socket);
    release();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await expect(control.request("b", {})).rejects.toMatchObject({ code: "closed" });
    expect(sockets).toHaveLength(1);
  });

  it("ignores a release it has already counted", () => {
    const { control } = harness();
    const first = control.retain();
    control.retain();
    first();
    first();
    // The second tile still holds it: a request now opens a connection.
    control.request("a", {}).catch(() => {});
    expect(control.connected).toBe(true);
  });

  it("fails what is in flight when the server closes, and reconnects on the next request", async () => {
    const { control, sockets } = harness();
    control.retain();
    const pending = control.request("a", {});
    const first = sockets[0] as FakeSocket;
    await handshake(first);
    first.emit("close", 1001);
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(control.connected).toBe(false);

    const again = control.request("a", {});
    expect(sockets).toHaveLength(2);
    await handshake(sockets[1] as FakeSocket);
    (sockets[1] as FakeSocket).answer("back");
    expect(await again).toBe("back");
  });

  it("reads instance_id on each connect, and a reconnect picks up the new one", async () => {
    const { control, sockets } = harness();
    control.retain();
    const first = control.instanceId();
    await handshake(sockets[0] as FakeSocket, "inst-1");
    expect(await first).toBe("inst-1");
    // Asking again on the same connection reads nothing more.
    expect(await control.instanceId()).toBe("inst-1");
    expect(
      (sockets[0] as FakeSocket).sent.filter((m) => m.method === "server.status"),
    ).toHaveLength(1);

    // The server restarts: the connection drops, the next one finds a new id.
    (sockets[0] as FakeSocket).emit("close", 1001);
    const second = control.instanceId();
    await handshake(sockets[1] as FakeSocket, "inst-2");
    expect(await second).toBe("inst-2");
  });

  it("reports the same instance_id after a reconnect to the same server", async () => {
    const { control, sockets } = harness();
    control.retain();
    const first = control.instanceId();
    await handshake(sockets[0] as FakeSocket, "inst-1");
    await first;
    (sockets[0] as FakeSocket).emit("close", 1006);
    const again = control.instanceId();
    await handshake(sockets[1] as FakeSocket, "inst-1");
    expect(await again).toBe("inst-1");
  });

  it("gives up on a status with no instance_id", async () => {
    const { control, sockets } = harness();
    control.retain();
    const pending = control.instanceId();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open");
    await settle();
    socket.say({ type: "welcome" });
    await settle();
    socket.answer({});
    await settle();
    socket.answer({});
    await expect(pending).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects the request when the connection fails to open", async () => {
    const { control, sockets } = harness();
    control.retain();
    const pending = control.request("a", {});
    (sockets[0] as FakeSocket).emit(
      "error",
      Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
    );
    await expect(pending).rejects.toThrow(/ENOENT/);
    expect(control.connected).toBe(false);
  });

  it("gives up on a hello answered by something other than a welcome", async () => {
    const { control, sockets } = harness();
    control.retain();
    const pending = control.request("a", {});
    const socket = sockets[0] as FakeSocket;
    socket.emit("open");
    socket.say({ type: "response", id: "x", payload: {} });
    await expect(pending).rejects.toMatchObject({ code: "invalid_response" });
    expect(socket.closed).toBe(true);
  });
});
