// Slack plugin module owns session routing for non-message events.
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, SessionScope } from "openclaw/plugin-sdk/config-contracts";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";
import { normalizeSlackChannelType } from "./channel-type.js";
import { resolveSessionKey } from "./config.runtime.js";

type SlackSystemEventSessionKeyParams = {
  channelId?: string | null;
  channelType?: string | null;
  senderId?: string | null;
  threadTs?: string | null;
};

export function createSlackSystemEventSessionKeyResolver(params: {
  cfg: OpenClawConfig;
  accountId: string;
  getTeamId: () => string;
  mainKey: string;
  sessionScope: SessionScope;
  threadInheritParent: boolean;
  recallSlackChannelType: (
    channelId: string | null | undefined,
  ) => SlackMessageEvent["channel_type"] | undefined;
}) {
  return (event: SlackSystemEventSessionKeyParams) => {
    const channelId = normalizeOptionalString(event.channelId) ?? "";
    const senderId = normalizeOptionalString(event.senderId) ?? "";
    // System events can omit channel_type too; prefer a type already seen on events
    // for this channel over C-prefix inference so they key the same session (#102676).
    const channelType = normalizeSlackChannelType(
      event.channelType ?? params.recallSlackChannelType(channelId),
      channelId,
    );
    const isDirectMessage = channelType === "im";
    if (!channelId && (!isDirectMessage || !senderId)) {
      return params.mainKey;
    }
    const isGroup = channelType === "mpim";
    const from = isDirectMessage
      ? `slack:${channelId || senderId}`
      : isGroup
        ? `slack:group:${channelId}`
        : `slack:channel:${channelId}`;
    const chatType = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
    // Resolve through shared channel/account bindings so system events route to
    // the same agent session as regular inbound messages.
    try {
      const peerKind = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
      const peerId = isDirectMessage ? senderId : channelId;
      if (peerId) {
        const route = resolveAgentRoute({
          cfg: params.cfg,
          channel: "slack",
          accountId: params.accountId,
          teamId: params.getTeamId(),
          peer: { kind: peerKind, id: peerId },
        });
        const threadTs = normalizeOptionalString(event.threadTs);
        const baseConversationId = isDirectMessage ? `user:${senderId}` : channelId;
        const threadBindingRoute = threadTs
          ? resolveRuntimeConversationBindingRoute({
              route,
              conversation: {
                channel: "slack",
                accountId: params.accountId,
                conversationId: threadTs,
                parentConversationId: baseConversationId,
              },
            })
          : null;
        const runtimeRoute =
          threadBindingRoute?.boundSessionKey || threadBindingRoute?.bindingRecord
            ? threadBindingRoute
            : resolveRuntimeConversationBindingRoute({
                route,
                conversation: {
                  channel: "slack",
                  accountId: params.accountId,
                  conversationId: baseConversationId,
                },
              });
        if (runtimeRoute.boundSessionKey) {
          return runtimeRoute.route.sessionKey;
        }
        return resolveThreadSessionKeys({
          baseSessionKey: runtimeRoute.route.sessionKey,
          threadId: threadTs,
          parentSessionKey:
            threadTs && params.threadInheritParent ? runtimeRoute.route.sessionKey : undefined,
        }).sessionKey;
      }
    } catch {
      // Fall through to legacy key derivation.
    }

    const legacySessionKey = resolveSessionKey(
      params.sessionScope,
      { From: from, ChatType: chatType, Provider: "slack" },
      params.mainKey,
      resolveDefaultAgentId(params.cfg),
    );
    return resolveThreadSessionKeys({
      baseSessionKey: legacySessionKey,
      threadId: normalizeOptionalString(event.threadTs),
      parentSessionKey:
        normalizeOptionalString(event.threadTs) && params.threadInheritParent
          ? legacySessionKey
          : undefined,
    }).sessionKey;
  };
}
