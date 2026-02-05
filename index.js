import { WecomWebhook } from "./webhook.js";
import { logger } from "./logger.js";
import { streamManager } from "./stream-manager.js";
import {
  generateAgentId,
  getDynamicAgentConfig,
  shouldTriggerGroupResponse,
  extractGroupMessageContent,
} from "./dynamic-agent.js";
import { processIncomingMessage, formatForAI } from "./message-handler.js";

const DEFAULT_ACCOUNT_ID = "default";

// =============================================================================
// 命令白名单配置
// =============================================================================

// 默认允许的斜杠命令（用户操作安全的命令）
const DEFAULT_COMMAND_ALLOWLIST = [
  "/new", // 新建会话
  "/compact", // 压缩会话
  "/help", // 帮助
  "/status", // 状态
];

// 默认拦截消息
const DEFAULT_COMMAND_BLOCK_MESSAGE = `⚠️ 该命令不可用。

支持的命令：
• **/new** - 新建会话
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看帮助
• **/status** - 查看状态`;

/**
 * 获取命令白名单配置
 */
function getCommandConfig(config) {
  const wecom = config?.channels?.wecom || {};
  const commands = wecom.commands || {};
  return {
    allowlist: commands.allowlist || DEFAULT_COMMAND_ALLOWLIST,
    blockMessage: commands.blockMessage || DEFAULT_COMMAND_BLOCK_MESSAGE,
    enabled: commands.enabled !== false, // 默认启用白名单
  };
}

/**
 * 检查命令是否在白名单中
 * @param {string} message - 用户消息
 * @param {Object} config - 配置
 * @returns {{ isCommand: boolean, allowed: boolean, command: string | null }}
 */
function checkCommandAllowlist(message, config) {
  const trimmed = message.trim();

  // 不是斜杠命令
  if (!trimmed.startsWith("/")) {
    return { isCommand: false, allowed: true, command: null };
  }

  // 提取命令（取第一个空格之前的部分）
  const command = trimmed.split(/\s+/)[0].toLowerCase();

  const cmdConfig = getCommandConfig(config);

  // 如果白名单功能禁用，允许所有命令
  if (!cmdConfig.enabled) {
    return { isCommand: true, allowed: true, command };
  }

  // 检查是否在白名单中
  const allowed = cmdConfig.allowlist.some(
    (cmd) => cmd.toLowerCase() === command,
  );

  return { isCommand: true, allowed, command };
}

// Runtime state (module-level singleton)
let _runtime = null;
let _openclawConfig = null;

/**
 * Set the plugin runtime (called during plugin registration)
 */
function setRuntime(runtime) {
  _runtime = runtime;
}

function getRuntime() {
  if (!_runtime) {
    throw new Error("[wecom] Runtime not initialized");
  }
  return _runtime;
}

// Webhook targets registry (similar to Google Chat)
const webhookTargets = new Map();

// Track active stream for each user, so outbound messages (like reset confirmation)
// can be added to the correct stream instead of using response_url
const activeStreams = new Map();

function normalizeWecomAllowFromEntry(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  return trimmed
    .replace(/^(wecom|wework):/i, "")
    .replace(/^user:/i, "")
    .toLowerCase();
}

function resolveWecomAllowFrom(cfg, accountId) {
  const wecom = cfg?.channels?.wecom;
  if (!wecom) return [];

  const normalizedAccountId = String(accountId || DEFAULT_ACCOUNT_ID)
    .trim()
    .toLowerCase();
  const accounts = wecom.accounts;
  const account =
    accounts && typeof accounts === "object"
      ? (accounts[accountId] ??
        accounts[
          Object.keys(accounts).find(
            (key) => key.toLowerCase() === normalizedAccountId,
          ) ?? ""
        ])
      : undefined;

  const allowFromRaw =
    account?.dm?.allowFrom ??
    account?.allowFrom ??
    wecom.dm?.allowFrom ??
    wecom.allowFrom ??
    [];

  if (!Array.isArray(allowFromRaw)) return [];

  return allowFromRaw
    .map(normalizeWecomAllowFromEntry)
    .filter((entry) => Boolean(entry));
}

function resolveWecomCommandAuthorized({ cfg, accountId, senderId }) {
  const sender = String(senderId ?? "")
    .trim()
    .toLowerCase();
  if (!sender) return false;

  const allowFrom = resolveWecomAllowFrom(cfg, accountId);
  if (allowFrom.includes("*") || allowFrom.length === 0) return true;
  return allowFrom.includes(sender);
}

function normalizeWebhookPath(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function registerWebhookTarget(target) {
  const key = normalizeWebhookPath(target.path);
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, { ...target, path: key }]);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((e) => e !== target);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

// =============================================================================
// Channel Plugin Definition
// =============================================================================

const wecomChannelPlugin = {
  id: "wecom",
  meta: {
    id: "wecom",
    label: "Enterprise WeChat",
    selectionLabel: "Enterprise WeChat (AI Bot)",
    docsPath: "/channels/wecom",
    blurb: "Enterprise WeChat AI Bot channel plugin.",
    aliases: ["wecom", "wework"],
  },
  capabilities: {
    chatTypes: ["direct", "group"], // 支持私聊和群聊
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true, // WeCom AI Bot uses stream response format
  },
  reload: { configPrefixes: ["channels.wecom"] },
  config: {
    listAccountIds: (cfg) => {
      const wecom = cfg?.channels?.wecom;
      if (!wecom || !wecom.enabled) return [];
      return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
      const wecom = cfg?.channels?.wecom;
      if (!wecom) return null;
      return {
        id: accountId || DEFAULT_ACCOUNT_ID,
        accountId: accountId || DEFAULT_ACCOUNT_ID,
        enabled: wecom.enabled !== false,
        token: wecom.token || "",
        encodingAesKey: wecom.encodingAesKey || "",
        webhookPath: wecom.webhookPath || "/webhooks/wecom",
        config: wecom,
      };
    },
    defaultAccountId: (cfg) => {
      const wecom = cfg?.channels?.wecom;
      if (!wecom || !wecom.enabled) return null;
      return DEFAULT_ACCOUNT_ID;
    },
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels.wecom) cfg.channels.wecom = {};
      cfg.channels.wecom.enabled = enabled;
      return cfg;
    },
    deleteAccount: ({ cfg, accountId }) => {
      if (cfg.channels?.wecom) delete cfg.channels.wecom;
      return cfg;
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  // Outbound adapter: Send messages via stream (all messages go through stream now)
  outbound: {
    sendText: async ({ cfg, to, text, accountId }) => {
      // to格式: \"wecom:userid\" 或 \"userid\"
      const userId = to.replace(/^wecom:/, "");

      // 获取该用户当前活跃的 streamId
      const streamId = activeStreams.get(userId);

      if (streamId && streamManager.hasStream(streamId)) {
        logger.debug("Appending outbound text to stream", {
          userId,
          streamId,
          text: text.substring(0, 30),
        });
        // 使用 appendStream 追加内容，保留之前的内容
        const stream = streamManager.getStream(streamId);
        const separator = stream && stream.content.length > 0 ? "\n\n" : "";
        streamManager.appendStream(streamId, separator + text);

        return {
          channel: "wecom",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      // 如果没有活跃的流，记录警告
      logger.warn("WeCom outbound: no active stream for user", { userId });

      return {
        channel: "wecom",
        messageId: `fake_${Date.now()}`,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const userId = to.replace(/^wecom:/, "");
      const streamId = activeStreams.get(userId);

      if (streamId && streamManager.hasStream(streamId)) {
        const content = text
          ? `${text}\n\n![image](${mediaUrl})`
          : `![image](${mediaUrl})`;
        logger.debug("Appending outbound media to stream", {
          userId,
          streamId,
          mediaUrl,
        });
        // 使用 appendStream 追加内容
        const stream = streamManager.getStream(streamId);
        const separator = stream && stream.content.length > 0 ? "\n\n" : "";
        streamManager.appendStream(streamId, separator + content);

        return {
          channel: "wecom",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      logger.warn("WeCom outbound sendMedia: no active stream", { userId });

      return {
        channel: "wecom",
        messageId: `fake_${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      logger.info("WeCom gateway starting", {
        accountId: account.accountId,
        webhookPath: account.webhookPath,
      });

      const unregister = registerWebhookTarget({
        path: account.webhookPath || "/webhooks/wecom",
        account,
        config: ctx.cfg,
      });

      return {
        shutdown: async () => {
          logger.info("WeCom gateway shutting down");
          unregister();
        },
      };
    },
  },
};

// =============================================================================
// HTTP Webhook Handler
// =============================================================================

async function wecomHttpHandler(req, res) {
  const url = new URL(req.url || "", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);

  if (!targets || targets.length === 0) {
    return false; // Not handled by this plugin
  }

  const query = Object.fromEntries(url.searchParams);
  logger.debug("WeCom HTTP request", { method: req.method, path });

  // GET: URL Verification
  if (req.method === "GET") {
    const target = targets[0]; // Use first target for verification
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    const webhook = new WecomWebhook({
      token: target.account.token,
      encodingAesKey: target.account.encodingAesKey,
    });

    const echo = webhook.handleVerify(query);
    if (echo) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(echo);
      logger.info("WeCom URL verification successful");
      return true;
    }

    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Verification failed");
    logger.warn("WeCom URL verification failed");
    return true;
  }

  // POST: Message handling
  if (req.method === "POST") {
    const target = targets[0];
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    // Read request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    logger.debug("WeCom message received", { bodyLength: body.length });

    const webhook = new WecomWebhook({
      token: target.account.token,
      encodingAesKey: target.account.encodingAesKey,
    });

    const result = await webhook.handleMessage(query, body);
    if (!result) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return true;
    }

    // Handle all message types (text, image, voice, mixed, etc.)
    if (result.message) {
      const msg = result.message;
      const { timestamp, nonce } = result.query;
      const msgType = msg.msgType || "text";
      const content = (msg.content || msg.textContent || "").trim();

      // 统一使用流式回复处理所有消息（包括命令）
      // 企业微信 AI Bot 的 response_url 只能使用一次，
      // 所以必须通过流式来发送所有回复内容
      const streamId = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      streamManager.createStream(streamId);

      // 被动回复：返回流式消息ID (同步响应)
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        "", // 初始内容为空
        false, // 未完成
        timestamp,
        nonce,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.info("Stream initiated", {
        streamId,
        from: msg.fromUser,
        msgType,
        isCommand: msgType === "text" && content.startsWith("/"),
      });
      // 异步处理消息 - 调用AI并更新流内容
      processInboundMessage({
        message: msg,
        streamId,
        timestamp,
        nonce,
        account: target.account,
        config: target.config,
      }).catch((err) => {
        logger.error("WeCom message processing failed", { error: err.message });
        // 即使失败也要标记流为完成
        streamManager.finishStream(streamId);
      });

      return true;
    }

    // Handle stream refresh - return current stream state
    if (result.stream) {
      const { timestamp, nonce } = result.query;
      const streamId = result.stream.id;

      // 获取流的当前状态
      const stream = streamManager.getStream(streamId);

      if (!stream) {
        // 流不存在或已过期,返回空的完成响应
        logger.warn("Stream not found for refresh", { streamId });
        const streamResponse = webhook.buildStreamResponse(
          streamId,
          "会话已过期",
          true,
          timestamp,
          nonce,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      // 返回当前流的内容
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        stream.content,
        stream.finished,
        timestamp,
        nonce,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.debug("Stream refresh response sent", {
        streamId,
        contentLength: stream.content.length,
        finished: stream.finished,
      });

      // 如果流已完成,在一段时间后清理
      if (stream.finished) {
        setTimeout(() => {
          streamManager.deleteStream(streamId);
        }, 30 * 1000); // 30秒后清理
      }

      return true;
    }

    // Handle event
    if (result.event) {
      logger.info("WeCom event received", { event: result.event });

      // 处理进入会话事件 - 发送欢迎语
      if (result.event?.event_type === "enter_chat") {
        const { timestamp, nonce } = result.query;
        const fromUser = result.event?.from?.userid || "";

        // 欢迎语内容
        const welcomeMessage = `你好！👋 我是 AI 助手。

你可以使用下面的指令管理会话：
• **/new** - 新建会话（清空上下文）
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看更多命令

有什么我可以帮你的吗？`;

        // 创建流并返回欢迎语
        const streamId = `welcome_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        streamManager.createStream(streamId);
        streamManager.appendStream(streamId, welcomeMessage);
        streamManager.finishStream(streamId);

        const streamResponse = webhook.buildStreamResponse(
          streamId,
          welcomeMessage,
          true, // 直接完成
          timestamp,
          nonce,
        );

        logger.info("Sending welcome message", { fromUser, streamId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return true;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return true;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
  return true;
}

// =============================================================================
// Inbound Message Processing (triggers AI response)
// =============================================================================

async function processInboundMessage({
  message,
  streamId,
  timestamp,
  nonce,
  account,
  config,
}) {
  const runtime = getRuntime();
  const core = runtime.channel;

  const senderId = message.fromUser;
  const msgType = message.msgType || "text";
  const responseUrl = message.responseUrl;
  const chatType = message.chatType || "single"; // "single" 或 "group"
  const chatId = message.chatId || ""; // 群聊 ID
  const isGroupChat = chatType === "group" && chatId;

  // 确定 peerId：群聊用 chatId，私聊用 senderId
  const peerId = isGroupChat ? chatId : senderId;
  const peerKind = isGroupChat ? "group" : "dm";
  const conversationId = isGroupChat
    ? `wecom:group:${chatId}`
    : `wecom:${senderId}`;

  // 设置用户当前活跃的 streamId，供 outbound.sendText 使用
  // 群聊时用 chatId 作为 key
  const streamKey = isGroupChat ? chatId : senderId;
  if (streamId) {
    activeStreams.set(streamKey, streamId);
  }

  // ========================================================================
  // 处理多媒体消息：将各种消息类型转换为 AI 可理解的内容
  // ========================================================================
  let rawContent = "";
  let mediaContext = null;

  if (msgType === "text") {
    rawContent = message.content || "";
  } else if (
    msgType === "image" ||
    msgType === "voice" ||
    msgType === "mixed" ||
    msgType === "file" ||
    msgType === "video"
  ) {
    try {
      // 使用消息处理器处理多媒体消息
      const processed = await processIncomingMessage(message, {
        encodingAesKey: account.encodingAesKey,
        corpId: config?.wecom?.corpId,
        secret: config?.wecom?.secret,
      });

      rawContent = processed.textContent || "";
      mediaContext = {
        type: msgType,
        supported: processed.supported,
        mediaItems: processed.mediaItems,
      };

      // 如果是不支持的消息类型，直接返回提示
      if (!processed.supported && processed.textContent) {
        logger.info("Returning unsupported message type response", {
          msgType,
          senderId,
        });
        if (streamId) {
          streamManager.appendStream(streamId, processed.textContent);
          streamManager.finishStream(streamId);
          activeStreams.delete(streamKey);
        }
        return;
      }
    } catch (error) {
      logger.error("Failed to process multimedia message", {
        msgType,
        error: error.message,
        senderId,
      });
      rawContent = `[收到${msgType === "image" ? "图片" : msgType === "voice" ? "语音" : msgType === "mixed" ? "图文" : msgType}消息，处理时发生错误]`;
    }
  } else {
    // 未知消息类型
    rawContent = `[收到未知类型消息: ${msgType}]`;
  }

  // 群聊消息检查：是否满足触发条件（@提及）
  let rawBody = rawContent;
  if (isGroupChat && msgType === "text") {
    if (!shouldTriggerGroupResponse(rawContent, config)) {
      logger.debug("WeCom: group message ignored (no mention)", {
        chatId,
        senderId,
      });
      return;
    }
    // 提取实际内容（移除 @提及）
    rawBody = extractGroupMessageContent(rawContent, config);
  }

  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: account.accountId,
    senderId,
  });

  if (!rawBody.trim()) {
    logger.debug("WeCom: empty message, skipping");
    return;
  }

  // ========================================================================
  // 命令白名单检查
  // ========================================================================
  const commandCheck = checkCommandAllowlist(rawBody, config);

  if (commandCheck.isCommand && !commandCheck.allowed) {
    // 命令不在白名单中，返回拒绝消息
    const cmdConfig = getCommandConfig(config);
    logger.warn("WeCom: blocked command", {
      command: commandCheck.command,
      from: senderId,
      chatType: peerKind,
    });

    // 通过流式响应返回拦截消息
    if (streamId) {
      streamManager.appendStream(streamId, cmdConfig.blockMessage);
      streamManager.finishStream(streamId);
      activeStreams.delete(streamKey);
    }
    return;
  }

  logger.info("WeCom processing message", {
    from: senderId,
    chatType: peerKind,
    peerId,
    msgType,
    content: rawBody.substring(0, 50),
    streamId,
    isCommand: commandCheck.isCommand,
    command: commandCheck.command,
    hasMediaContext: !!mediaContext,
  });

  // ========================================================================
  // 动态 Agent 逻辑（极简版）
  // 只需要生成 agentId 和构造 SessionKey，OpenClaw 会自动创建 workspace
  // ========================================================================
  const dynamicConfig = getDynamicAgentConfig(config);

  // 生成目标 AgentId
  const targetAgentId = dynamicConfig.enabled
    ? generateAgentId(peerKind, peerId)
    : null;

  if (targetAgentId) {
    logger.debug("Using dynamic agent", {
      agentId: targetAgentId,
      chatType: peerKind,
      peerId,
    });
  }

  // ========================================================================
  // 路由到目标 Agent
  // ========================================================================
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: {
      kind: peerKind,
      id: peerId,
    },
  });

  // 使用动态 Agent，覆盖默认路由
  if (targetAgentId) {
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${peerKind}:${peerId}`;
  }

  // Build inbound context
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // 构建消息头，群聊时显示发送者
  const senderLabel = isGroupChat ? `[${senderId}]` : senderId;
  const body = core.reply.formatAgentEnvelope({
    channel: isGroupChat ? "Enterprise WeChat Group" : "Enterprise WeChat",
    from: senderLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `wecom:${senderId}`,
    To: conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat ? `群聊 ${chatId}` : senderId,
    SenderName: senderId,
    SenderId: senderId,
    GroupId: isGroupChat ? chatId : undefined,
    Provider: "wecom",
    Surface: "wecom",
    OriginatingChannel: "wecom",
    OriginatingTo: conversationId,
    CommandAuthorized: commandAuthorized,
  });

  // Record session meta
  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error("WeCom: failed updating session meta", {
        error: err.message,
      });
    });

  // Dispatch reply with AI processing
  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        logger.info("Dispatcher deliver called", {
          kind: info.kind,
          hasText: !!(payload.text && payload.text.trim()),
          textPreview: (payload.text || "").substring(0, 50),
        });

        await deliverWecomReply({
          payload,
          account,
          responseUrl,
          senderId: streamKey, // 使用 streamKey（群聊时是 chatId）
          streamId,
        });

        // 如果是最终回复,标记流为完成
        if (streamId && info.kind === "final") {
          streamManager.finishStream(streamId);
          logger.info("WeCom stream finished", { streamId });
        }
      },
      onError: (err, info) => {
        logger.error("WeCom reply failed", {
          error: err.message,
          kind: info.kind,
        });
        // 发生错误时也标记流为完成
        if (streamId) {
          streamManager.finishStream(streamId);
        }
      },
    },
  });

  // 确保在dispatch完成后标记流为完成（兜底机制）
  if (streamId) {
    streamManager.finishStream(streamId);
    activeStreams.delete(streamKey); // 清理活跃流映射
    logger.info("WeCom stream finished (dispatch complete)", { streamId });
  }
}

// =============================================================================
// Outbound Reply Delivery (Stream-only mode)
// =============================================================================

async function deliverWecomReply({
  payload,
  account,
  responseUrl,
  senderId,
  streamId,
}) {
  const text = payload.text || "";

  logger.debug("deliverWecomReply called", {
    hasText: !!text.trim(),
    textPreview: text.substring(0, 50),
    streamId,
    senderId,
  });

  // 所有消息都通过流式发送
  if (!text.trim()) {
    logger.debug("WeCom: empty block, skipping stream update");
    return;
  }

  // 辅助函数：追加内容到流（带去重）
  const appendToStream = (targetStreamId, content) => {
    const stream = streamManager.getStream(targetStreamId);
    if (!stream) return false;

    // 去重：检查流内容是否已包含此消息（避免 block + final 重复）
    if (stream.content.includes(content.trim())) {
      logger.debug("WeCom: duplicate content, skipping", {
        streamId: targetStreamId,
        contentPreview: content.substring(0, 30),
      });
      return true; // 返回 true 表示不需要再发送
    }

    const separator = stream.content.length > 0 ? "\n\n" : "";
    streamManager.appendStream(targetStreamId, separator + content);
    return true;
  };

  if (!streamId) {
    // 尝试从 activeStreams 获取
    const activeStreamId = activeStreams.get(senderId);
    if (activeStreamId && streamManager.hasStream(activeStreamId)) {
      appendToStream(activeStreamId, text);
      logger.debug("WeCom stream appended (via activeStreams)", {
        streamId: activeStreamId,
        contentLength: text.length,
      });
      return;
    }
    logger.warn("WeCom: no active stream for this message", { senderId });
    return;
  }

  if (!streamManager.hasStream(streamId)) {
    logger.warn("WeCom: stream not found, cannot update", { streamId });
    return;
  }

  appendToStream(streamId, text);
  logger.debug("WeCom stream appended", {
    streamId,
    contentLength: text.length,
    to: senderId,
  });
}

// =============================================================================
// Plugin Registration
// =============================================================================

const plugin = {
  id: "openclaw-plugin-wecom",
  name: "Enterprise WeChat",
  description: "Enterprise WeChat AI Bot channel plugin for OpenClaw",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) {
    logger.info("WeCom plugin registering...");

    // Save runtime for message processing
    setRuntime(api.runtime);
    _openclawConfig = api.config;

    // Register channel
    api.registerChannel({ plugin: wecomChannelPlugin });
    logger.info("WeCom channel registered");

    // Register HTTP handler for webhooks
    api.registerHttpHandler(wecomHttpHandler);
    logger.info("WeCom HTTP handler registered");
  },
};

export default plugin;
export const register = (api) => plugin.register(api);
