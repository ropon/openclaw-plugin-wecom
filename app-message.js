/**
 * 企业微信应用消息 API
 * 用于主动推送消息给用户（不依赖 response_url）
 * https://developer.work.weixin.qq.com/document/path/90236
 */

import { logger } from "./logger.js";
import { withRetry, parseWxWorkError, CONSTANTS } from "./utils.js";
import { getAccessToken } from "./contact-api.js";
import { uploadImage } from "./media-api.js";

/**
 * 发送应用消息给指定用户
 * https://developer.work.weixin.qq.com/document/path/90236
 *
 * @param {Object} params
 * @param {string} params.corpId - 企业ID
 * @param {string} params.secret - 应用密钥
 * @param {number} params.agentId - 应用AgentId
 * @param {string} params.toUser - 接收人userid（多个用 | 分隔，最多1000个）
 * @param {string} params.toParty - 接收部门ID（多个用 | 分隔）
 * @param {string} params.toTag - 接收标签ID（多个用 | 分隔）
 * @param {Object} params.message - 消息内容
 * @param {boolean} params.safe - 是否保密消息（0=否 1=是）
 * @param {boolean} params.enableIdTrans - 是否开启id转译
 * @param {boolean} params.enableDuplicateCheck - 是否去重
 * @param {number} params.duplicateCheckInterval - 去重时间间隔（秒）
 */
export async function sendAppMessage({
  corpId,
  secret,
  agentId,
  toUser = "",
  toParty = "",
  toTag = "",
  message,
  safe = 0,
  enableIdTrans = 0,
  enableDuplicateCheck = false,
  duplicateCheckInterval = 1800,
}) {
  if (!corpId || !secret || !agentId) {
    throw new Error("corpId, secret, and agentId are required");
  }

  if (!toUser && !toParty && !toTag) {
    throw new Error(
      "At least one of toUser, toParty, or toTag must be specified",
    );
  }

  // 获取 access_token
  const accessToken = await getAccessToken(corpId, secret);

  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;

  const payload = {
    touser: toUser,
    toparty: toParty,
    totag: toTag,
    msgtype: message.msgtype,
    agentid: agentId,
    safe: safe,
    enable_id_trans: enableIdTrans,
    enable_duplicate_check: enableDuplicateCheck ? 1 : 0,
    duplicate_check_interval: duplicateCheckInterval,
  };

  // 根据消息类型添加对应字段
  switch (message.msgtype) {
    case "text":
      payload.text = message.text;
      break;
    case "markdown":
      payload.markdown = message.markdown;
      break;
    case "textcard":
      payload.textcard = message.textcard;
      break;
    case "image":
      payload.image = message.image;
      break;
    case "news":
      payload.news = message.news;
      break;
    case "file":
      payload.file = message.file;
      break;
    case "video":
      payload.video = message.video;
      break;
    default:
      throw new Error(`Unsupported message type: ${message.msgtype}`);
  }

  logger.debug("Sending app message", {
    toUser,
    msgtype: message.msgtype,
    agentId,
  });

  const response = await withRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONSTANTS.WEBHOOK_RESPONSE_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.errcode !== 0) {
        const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
        throw new Error(
          `Send app message failed: [${data.errcode}] ${errorInfo.message}`,
        );
      }

      return data;
    },
    {
      retries: 2,
      minTimeout: 500,
      maxTimeout: 2000,
      onRetry: (error, attempt) => {
        logger.warn(`Send app message retry ${attempt}/2`, {
          error: error.message,
          toUser,
        });
      },
    },
  );

  logger.info("App message sent successfully", {
    toUser,
    msgtype: message.msgtype,
    invalidUser: response.invaliduser,
    invalidParty: response.invalidparty,
    invalidTag: response.invalidtag,
  });

  return response;
}

/**
 * 发送文本消息
 */
export async function sendTextMessage({
  corpId,
  secret,
  agentId,
  toUser,
  content,
}) {
  return sendAppMessage({
    corpId,
    secret,
    agentId,
    toUser,
    message: {
      msgtype: "text",
      text: {
        content,
      },
    },
  });
}

/**
 * 发送 Markdown 消息
 */
export async function sendMarkdownMessage({
  corpId,
  secret,
  agentId,
  toUser,
  content,
}) {
  return sendAppMessage({
    corpId,
    secret,
    agentId,
    toUser,
    message: {
      msgtype: "markdown",
      markdown: {
        content,
      },
    },
  });
}

/**
 * 发送图片消息
 * 支持传入 media_id 或 文件路径（自动上传）
 * 
 * @param {Object} params
 * @param {string} params.corpId - 企业ID
 * @param {string} params.secret - 应用密钥
 * @param {number} params.agentId - 应用AgentId
 * @param {string} params.toUser - 接收人userid
 * @param {string} [params.mediaId] - 图片media_id（与filePath二选一）
 * @param {string} [params.filePath] - 图片文件路径（与mediaId二选一，会自动上传）
 */
export async function sendImageMessage({
  corpId,
  secret,
  agentId,
  toUser,
  mediaId,
  filePath,
}) {
  // 如果提供的是文件路径，先上传获取 media_id
  let finalMediaId = mediaId;
  
  if (!finalMediaId && filePath) {
    logger.info("Uploading image before sending", { filePath, toUser });
    finalMediaId = await uploadImage({ corpId, secret, filePath });
  }
  
  if (!finalMediaId) {
    throw new Error("Either mediaId or filePath must be provided");
  }

  return sendAppMessage({
    corpId,
    secret,
    agentId,
    toUser,
    message: {
      msgtype: "image",
      image: {
        media_id: finalMediaId,
      },
    },
  });
}

/**
 * 发送文件消息
 * 支持传入 media_id 或 文件路径（自动上传）
 */
export async function sendFileMessage({
  corpId,
  secret,
  agentId,
  toUser,
  mediaId,
  filePath,
}) {
  let finalMediaId = mediaId;
  
  if (!finalMediaId && filePath) {
    const { uploadMedia } = await import("./media-api.js");
    logger.info("Uploading file before sending", { filePath, toUser });
    finalMediaId = await uploadMedia({ corpId, secret, filePath, type: "file" });
  }
  
  if (!finalMediaId) {
    throw new Error("Either mediaId or filePath must be provided");
  }

  return sendAppMessage({
    corpId,
    secret,
    agentId,
    toUser,
    message: {
      msgtype: "file",
      file: {
        media_id: finalMediaId,
      },
    },
  });
}

/**
 * 发送文本卡片消息
 * https://developer.work.weixin.qq.com/document/path/90236#文本卡片消息
 */
export async function sendTextCardMessage({
  corpId,
  secret,
  agentId,
  toUser,
  title,
  description,
  url,
  btnTxt = "详情",
}) {
  return sendAppMessage({
    corpId,
    secret,
    agentId,
    toUser,
    message: {
      msgtype: "textcard",
      textcard: {
        title,
        description,
        url,
        btntxt: btnTxt,
      },
    },
  });
}

/**
 * 发送图文消息
 * https://developer.work.weixin.qq.com/document/path/90236#图文消息
 */
export async function sendNewsMessage({
  corpId,
  secret,
  agentId,
  toUser,
  articles,
}) {
  return sendAppMessage({
    corpId,
    secret,
    agentId,
    toUser,
    message: {
      msgtype: "news",
      news: {
        articles, // [{title, description, url, picurl}]
      },
    },
  });
}

/**
 * 批量发送消息给多个用户
 * 自动分批处理（每批最多1000个用户）
 */
export async function sendBatchMessage({
  corpId,
  secret,
  agentId,
  userIds,
  message,
}) {
  const BATCH_SIZE = 1000;
  const results = [];

  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    const toUser = batch.join("|");

    logger.debug(`Sending batch ${i / BATCH_SIZE + 1}`, {
      batchSize: batch.length,
      totalBatches: Math.ceil(userIds.length / BATCH_SIZE),
    });

    const result = await sendAppMessage({
      corpId,
      secret,
      agentId,
      toUser,
      message,
    });

    results.push(result);
  }

  return results;
}

/**
 * 发送视频消息
 * 支持传入 media_id 或 文件路径（自动上传）
 * 
 * @param {Object} params
 * @param {string} params.corpId - 企业ID
 * @param {string} params.secret - 应用密钥
 * @param {number} params.agentId - 应用AgentId
 * @param {string} params.toUser - 接收人userid
 * @param {string} [params.mediaId] - 视频media_id（与filePath二选一）
 * @param {string} [params.filePath] - 视频文件路径（与mediaId二选一，会自动上传）
 * @param {string} [params.title] - 视频标题
 * @param {string} [params.description] - 视频描述
 */
export async function sendVideoMessage({
  corpId,
  secret,
  agentId,
  toUser,
  mediaId,
  filePath,
  title,
  description,
}) {
  let finalMediaId = mediaId;
  
  if (!finalMediaId && filePath) {
    const { uploadMedia } = await import("./media-api.js");
    logger.info("Uploading video before sending", { filePath, toUser });
    finalMediaId = await uploadMedia({ corpId, secret, filePath, type: "video" });
  }
  
  if (!finalMediaId) {
    throw new Error("Either mediaId or filePath must be provided");
  }

  return sendAppMessage({
    corpId,
    secret,
    agentId,
    toUser,
    message: {
      msgtype: "video",
      video: {
        media_id: finalMediaId,
        title: title || "",
        description: description || "",
      },
    },
  });
}
