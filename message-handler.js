/**
 * 企业微信消息处理器
 * 统一处理各种类型的消息（文本、图片、语音、混合消息等）
 * 将多媒体消息转换为 AI 可理解的格式
 */

import { logger } from "./logger.js";
import { downloadAndDecryptImage, cleanupOldImages } from "./image-decrypt.js";
import {
  downloadVoice,
  formatVoiceForAI,
  getVoiceNotSupportedMessage,
} from "./voice-api.js";
import { downloadMedia } from "./media-api.js";
import fs from "fs";
import path from "path";

/**
 * 消息处理配置
 */
const MESSAGE_CONFIG = {
  // 是否启用图片处理
  enableImageProcessing: true,
  // 是否启用语音处理
  enableVoiceProcessing: true,
  // 图片最大尺寸（字节）
  maxImageSize: 10 * 1024 * 1024, // 10MB
  // 语音最大时长（秒）
  maxVoiceDuration: 60,
  // 是否将图片转为 Base64
  convertImageToBase64: true,
};

/**
 * 处理接收到的消息，返回统一格式的消息内容
 *
 * @param {Object} message - 原始消息对象
 * @param {Object} context - 上下文（包含 encodingAesKey 等配置）
 * @returns {Promise<ProcessedMessage>} 处理后的消息
 *
 * @typedef {Object} ProcessedMessage
 * @property {string} type - 消息类型 (text/image/voice/mixed)
 * @property {string} textContent - 文本内容（供 AI 处理）
 * @property {Array<MediaItem>} mediaItems - 媒体项列表
 * @property {Object} original - 原始消息
 */
export async function processIncomingMessage(message, context = {}) {
  const { encodingAesKey, corpId, secret } = context;
  const msgType = message.msgType || "text";

  logger.debug("Processing incoming message", {
    msgType,
    fromUser: message.fromUser,
  });

  switch (msgType) {
    case "text":
      return processTextMessage(message);

    case "image":
      return processImageMessage(message, { encodingAesKey, corpId, secret });

    case "voice":
      return processVoiceMessage(message, { corpId, secret });

    case "mixed":
      return processMixedMessage(message, { encodingAesKey, corpId, secret });

    case "file":
      return processFileMessage(message);

    case "video":
      return processVideoMessage(message);

    default:
      logger.warn("Unsupported message type", { msgType });
      return {
        type: msgType,
        textContent: `[收到不支持的消息类型: ${msgType}]`,
        mediaItems: [],
        original: message,
        supported: false,
      };
  }
}

/**
 * 处理文本消息
 */
function processTextMessage(message) {
  return {
    type: "text",
    textContent: message.content || "",
    mediaItems: [],
    original: message,
    supported: true,
  };
}

/**
 * 处理图片消息
 */
async function processImageMessage(message, context) {
  const { encodingAesKey, corpId, secret } = context;
  const mediaItems = [];
  let textContent = "";

  try {
    // 企业微信 AI Bot 的图片是加密的，需要解密
    if (message.imageUrl && encodingAesKey) {
      const result = await downloadAndDecryptImage(
        message.imageUrl,
        encodingAesKey,
      );

      if (result.success && result.localPath) {
        const imageItem = {
          type: "image",
          localPath: result.localPath,
          url: message.imageUrl,
          processed: true,
        };

        // 可选：将图片转为 Base64 供 AI 使用
        if (MESSAGE_CONFIG.convertImageToBase64) {
          try {
            const imageBuffer = fs.readFileSync(result.localPath);
            const ext = path.extname(result.localPath).toLowerCase();
            const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
            imageItem.base64 = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
          } catch (e) {
            logger.warn("Failed to convert image to base64", {
              error: e.message,
            });
          }
        }

        mediaItems.push(imageItem);
        textContent = "[用户发送了一张图片]";
      } else {
        textContent = `[用户发送了一张图片，但解密失败: ${result.error}]`;
      }
    } else if (message.mediaId && corpId && secret) {
      // 通过 media_id 下载
      const result = await downloadMedia({
        corpId,
        secret,
        mediaId: message.mediaId,
      });
      if (result.success) {
        mediaItems.push({
          type: "image",
          localPath: result.localPath,
          mimeType: result.mimeType,
          processed: true,
        });
        textContent = "[用户发送了一张图片]";
      } else {
        textContent = `[用户发送了一张图片，但下载失败: ${result.error}]`;
      }
    } else {
      textContent =
        "[用户发送了一张图片，但无法处理（缺少解密密钥或 API 配置）]";
    }
  } catch (error) {
    logger.error("Failed to process image message", { error: error.message });
    textContent = "[用户发送了一张图片，处理时发生错误]";
  }

  return {
    type: "image",
    textContent,
    mediaItems,
    original: message,
    supported: mediaItems.length > 0,
  };
}

/**
 * 处理语音消息
 */
async function processVoiceMessage(message, context) {
  const { corpId, secret } = context;

  // 目前语音消息需要额外的语音识别服务
  // 这里只做下载和提示
  if (!MESSAGE_CONFIG.enableVoiceProcessing) {
    return {
      type: "voice",
      textContent: getVoiceNotSupportedMessage(),
      mediaItems: [],
      original: message,
      supported: false,
    };
  }

  try {
    if (message.mediaId && corpId && secret) {
      const result = await downloadVoice({
        corpId,
        secret,
        mediaId: message.mediaId,
      });

      if (result.success) {
        return {
          type: "voice",
          textContent: formatVoiceForAI({
            exists: true,
            size: result.size,
            format: "amr",
            path: result.localPath,
          }),
          mediaItems: [
            {
              type: "voice",
              localPath: result.localPath,
              size: result.size,
              processed: true,
            },
          ],
          original: message,
          supported: true,
          needsTranscription: true, // 标记需要语音转文字
        };
      }
    }
  } catch (error) {
    logger.error("Failed to process voice message", { error: error.message });
  }

  return {
    type: "voice",
    textContent: getVoiceNotSupportedMessage(),
    mediaItems: [],
    original: message,
    supported: false,
  };
}

/**
 * 处理混合消息（图文混合）
 */
async function processMixedMessage(message, context) {
  const { encodingAesKey, corpId, secret } = context;
  const items = message.items || [];
  const mediaItems = [];
  let textContent = message.textContent || "";
  const contentParts = [];

  for (const item of items) {
    switch (item.type) {
      case "text":
        contentParts.push(item.content);
        break;

      case "image":
        try {
          if (item.url && encodingAesKey) {
            const result = await downloadAndDecryptImage(
              item.url,
              encodingAesKey,
            );
            if (result.success) {
              mediaItems.push({
                type: "image",
                localPath: result.localPath,
                url: item.url,
                processed: true,
              });
              contentParts.push("[图片]");
            } else {
              contentParts.push("[图片-无法解密]");
            }
          } else if (item.mediaId && corpId && secret) {
            const result = await downloadMedia({
              corpId,
              secret,
              mediaId: item.mediaId,
            });
            if (result.success) {
              mediaItems.push({
                type: "image",
                localPath: result.localPath,
                processed: true,
              });
              contentParts.push("[图片]");
            } else {
              contentParts.push("[图片-下载失败]");
            }
          } else {
            contentParts.push("[图片]");
          }
        } catch (e) {
          contentParts.push("[图片-处理失败]");
        }
        break;

      case "voice":
        contentParts.push("[语音消息]");
        mediaItems.push({
          type: "voice",
          mediaId: item.mediaId,
          processed: false,
        });
        break;

      case "video":
        contentParts.push("[视频]");
        mediaItems.push({
          type: "video",
          mediaId: item.mediaId,
          processed: false,
        });
        break;

      case "file":
        contentParts.push(`[文件: ${item.name || "未知"}]`);
        mediaItems.push({
          type: "file",
          mediaId: item.mediaId,
          name: item.name,
          processed: false,
        });
        break;
    }
  }

  // 如果没有从 items 中提取到文本，使用消息中的 textContent
  if (contentParts.length === 0 && textContent) {
    contentParts.push(textContent);
  }

  return {
    type: "mixed",
    textContent: contentParts.join(" ") || textContent,
    mediaItems,
    original: message,
    supported: true,
  };
}

/**
 * 处理文件消息
 */
function processFileMessage(message) {
  return {
    type: "file",
    textContent: `[用户发送了文件: ${message.fileName || "未知文件"}]`,
    mediaItems: [
      {
        type: "file",
        mediaId: message.mediaId,
        name: message.fileName,
        processed: false,
      },
    ],
    original: message,
    supported: false, // 文件需要特殊处理
  };
}

/**
 * 处理视频消息
 */
function processVideoMessage(message) {
  return {
    type: "video",
    textContent: "[用户发送了一段视频]",
    mediaItems: [
      {
        type: "video",
        mediaId: message.mediaId,
        processed: false,
      },
    ],
    original: message,
    supported: false, // 视频需要特殊处理
  };
}

/**
 * 将处理后的消息格式化为 AI 输入格式
 *
 * @param {ProcessedMessage} processed - 处理后的消息
 * @param {Object} options - 格式化选项
 * @returns {Object} AI 输入格式
 */
export function formatForAI(processed, options = {}) {
  const { includeMediaDescription = true, maxTextLength = 10000 } = options;

  // 如果是纯文本
  if (processed.type === "text") {
    return {
      type: "text",
      content: processed.textContent.substring(0, maxTextLength),
    };
  }

  // 如果包含图片且有 base64
  const imageWithBase64 = processed.mediaItems.find(
    (item) => item.type === "image" && item.base64,
  );

  if (imageWithBase64) {
    // 返回多模态格式
    return {
      type: "multimodal",
      content: [
        { type: "text", text: processed.textContent || "请描述这张图片" },
        { type: "image_url", image_url: { url: imageWithBase64.base64 } },
      ],
    };
  }

  // 默认返回文本描述
  let content = processed.textContent;

  if (includeMediaDescription && processed.mediaItems.length > 0) {
    const mediaDesc = processed.mediaItems
      .map((item) => {
        switch (item.type) {
          case "image":
            return "[图片]";
          case "voice":
            return "[语音]";
          case "video":
            return "[视频]";
          case "file":
            return `[文件: ${item.name || ""}]`;
          default:
            return `[${item.type}]`;
        }
      })
      .join(" ");

    if (content && !content.includes("[")) {
      content = `${content} ${mediaDesc}`;
    } else if (!content) {
      content = mediaDesc;
    }
  }

  return {
    type: "text",
    content: content.substring(0, maxTextLength),
  };
}

/**
 * 定期清理临时媒体文件
 */
export async function cleanupTempFiles() {
  try {
    await cleanupOldImages();
    // 可以添加其他清理逻辑
    logger.debug("Temporary media files cleaned up");
  } catch (error) {
    logger.warn("Failed to cleanup temp files", { error: error.message });
  }
}

// 每小时自动清理一次临时文件
setInterval(cleanupTempFiles, 3600 * 1000);
