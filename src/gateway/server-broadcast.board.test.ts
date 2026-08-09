import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionObserverAudience } from "./session-observer-audience.js";

type RecordingSocket = {
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  events: string[];
};

function makeClient(
  connId: string,
  role: "node" | "operator",
  scopes: string[],
): { client: GatewayWsClient; socket: RecordingSocket } {
  const events: string[] = [];
  const socket: RecordingSocket = {
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      events.push((JSON.parse(payload) as { event: string }).event);
    }),
    events,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role, scopes } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}

describe("skills event scope guards", () => {
  it("delivers skill invalidations only to read-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const write = makeClient("write", "operator", ["operator.write"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new Set([pairing, node, read, write, admin].map((entry) => entry.client));
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("skills.changed", { reason: "remote-node" });

    expect(pairing.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual(["skills.changed"]);
    expect(write.socket.events).toEqual(["skills.changed"]);
    expect(admin.socket.events).toEqual(["skills.changed"]);
  });
});

describe("board event scope guards", () => {
  it("delivers board events only to read-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const write = makeClient("write", "operator", ["operator.write"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new Set([pairing, node, read, write, admin].map((entry) => entry.client));
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("board.changed", { sessionKey: "agent:main:main", revision: 1 });
    broadcast("board.command", {
      sessionKey: "agent:main:main",
      command: { kind: "focus_tab", tabId: "main" },
    });

    expect(pairing.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual(["board.changed", "board.command"]);
    expect(write.socket.events).toEqual(["board.changed", "board.command"]);
    expect(admin.socket.events).toEqual(["board.changed", "board.command"]);
  });

  it("applies session visibility filtering from the event payload key", () => {
    const hidden = makeClient("hidden", "operator", ["operator.read"]);
    const visible = makeClient("visible", "operator", ["operator.read"]);
    const canReceiveSessionEvent = vi.fn(
      (client: GatewayWsClient, sessionKeys: readonly string[], agentId?: string) => {
        expect(sessionKeys).toEqual(["global"]);
        expect(agentId).toBe("work");
        return client.connId === "visible";
      },
    );
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([hidden.client, visible.client]),
      canReceiveSessionEvent,
    });

    broadcast("board.changed", {
      request: { sessionKey: "global", agentId: "work" },
      revision: 1,
    });

    expect(hidden.socket.events).toEqual([]);
    expect(visible.socket.events).toEqual(["board.changed"]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(2);
  });
});

describe("collaboration event scope guards", () => {
  it("uses the payload session scope for observer subscription filtering", () => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const otherSession = makeClient("other-session", "operator", ["operator.read"]);
    const unsubscribed = makeClient("unsubscribed", "operator", ["operator.read"]);
    for (const entry of [subscribed, otherSession, unsubscribed]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe(subscribed.client.connId, "agent:main:main");
    sessionMessageSubscribers.subscribe(otherSession.client.connId, "agent:main:other");
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([subscribed.client, otherSession.client, unsubscribed.client]),
      sessionMessageSubscribers,
    });

    broadcast(
      "session.observer",
      { sessionKey: "agent:main:main", revision: 1 },
      { dropIfSlow: true },
    );

    expect(subscribed.socket.events).toEqual(["session.observer"]);
    expect(otherSession.socket.events).toEqual([]);
    expect(unsubscribed.socket.events).toEqual([]);
  });

  it("delivers selected global observer digests only to their owning agent's sockets", () => {
    const main = makeClient("main", "operator", ["operator.read"]);
    const work = makeClient("work", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    for (const entry of [main, work, unrelated]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(main.client.connId, "agent:main:global");
    subscribers.subscribe(work.client.connId, "agent:work:global");
    subscribers.subscribe(unrelated.client.connId, "agent:work:other");
    const audience = createSessionObserverAudience({
      subscribers,
      isVisible: () => true,
      getDefaultAgentId: () => "main",
    });
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new Set([main.client, work.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    for (const agentId of ["main", "work"]) {
      const recipients = audience.recipients("global", agentId);
      expect(recipients).toEqual(new Set([agentId]));
      broadcastToConnIds("session.observer", { sessionKey: "global", agentId }, recipients);
    }

    expect(main.socket.events).toEqual(["session.observer"]);
    expect(work.socket.events).toEqual(["session.observer"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it.each(["agent", "chat", "chat.side_result"])(
    "keeps global %s events scoped to their owning agent",
    (event) => {
      const work = makeClient("work", "operator", ["operator.read"]);
      const main = makeClient("main", "operator", ["operator.read"]);
      const bareGlobal = makeClient("bare-global", "operator", ["operator.read"]);
      for (const entry of [work, main, bareGlobal]) {
        entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
      }
      const subscribers = createSessionMessageSubscriberRegistry();
      subscribers.subscribe(work.client.connId, "agent:work:global");
      subscribers.subscribe(main.client.connId, "agent:main:global");
      subscribers.subscribe(bareGlobal.client.connId, "global");
      const { broadcast } = createGatewayBroadcaster({
        clients: new Set([work.client, main.client, bareGlobal.client]),
        sessionMessageSubscribers: subscribers,
      });

      broadcast(event, { sessionKey: "global", agentId: "work" });

      expect(work.socket.events).toEqual([event]);
      expect(main.socket.events).toEqual([]);
      expect(bareGlobal.socket.events).toEqual([]);
    },
  );

  it("delivers global typing indicators to ordinary subscribed Control UI connections", () => {
    const main = makeClient("main", "operator", ["operator.read"]);
    const work = makeClient("work", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(main.client.connId, "agent:main:global");
    subscribers.subscribe(work.client.connId, "agent:work:global");
    subscribers.subscribe(unrelated.client.connId, "agent:work:other");
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([main.client, work.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    for (const agentId of ["main", "work"]) {
      broadcast("session.typing", { sessionKey: "global", agentId, typing: true });
    }

    expect(main.socket.events).toEqual(["session.typing"]);
    expect(work.socket.events).toEqual(["session.typing"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it.each([
    { sessionKey: "agent:work:global", agentId: "work" },
    { sessionKey: "agent:work:other", agentId: "work" },
    { sessionKey: "global", agentId: undefined },
  ])("preserves exact subscription keys for $sessionKey", ({ sessionKey, agentId }) => {
    const subscribed = makeClient("subscribed", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    subscribed.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    unrelated.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(subscribed.client.connId, sessionKey);
    subscribers.subscribe(unrelated.client.connId, "agent:other:global");
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([subscribed.client, unrelated.client]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast("chat", { sessionKey, ...(agentId ? { agentId } : {}) });

    expect(subscribed.socket.events).toEqual(["chat"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it("guards suggestion and typing events and forwards payloads to visibility filtering", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const reader = makeClient("reader", "operator", ["operator.read"]);
    const unrelated = makeClient("unrelated", "operator", ["operator.read"]);
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("reader", "agent:main:main");
    const canReceiveSessionEvent = vi.fn(
      (
        _client: GatewayWsClient,
        sessionKeys: readonly string[],
        agentId: string | undefined,
        event: string | undefined,
        payload: unknown,
      ) => {
        expect(sessionKeys).toEqual(["agent:main:main"]);
        expect(agentId).toBe("main");
        expect(payload).toBeDefined();
        return event === "session.typing";
      },
    );
    const { broadcast } = createGatewayBroadcaster({
      clients: new Set([pairing.client, reader.client, unrelated.client]),
      canReceiveSessionEvent,
      sessionMessageSubscribers,
    });

    broadcast("session.suggestion", {
      suggestion: { sessionKey: "agent:main:main", agentId: "main" },
    });
    broadcast(
      "session.typing",
      {
        sessionKey: "agent:main:main",
        agentId: "main",
        typing: true,
      },
      { sessionKeys: ["agent:main:main"], agentId: "main" },
    );

    expect(pairing.socket.events).toEqual([]);
    expect(reader.socket.events).toEqual(["session.typing"]);
    expect(unrelated.socket.events).toEqual([]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(4);
  });
});
