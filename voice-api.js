/**
 * 企业微信语音处理 API
 * 支持语音下载和可选的语音转文字功能
 * https://developer.work.weixin.qq.com/document/path/90254
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import { withRetry, parseWxWorkError, CONSTANTS } from "./utils.js";
import { getAccessToken } from "./contact-api.js";

// 临时语音存储目录
const TEMP_VOICE_DIR = "/tmp/wxwork_voice";

/**
 * 下载语音素材
 * https://developer.work.weixin.qq.com/document/path/90254
 *
 * @param {Object} params
 * @param {string} params.corpId - 企业ID
 * @param {string} params.secret - 应用密钥
 * @param {string} params.mediaId - 语音的media_id
 * @returns {Promise<{success: boolean, localPath?: string, error?: string}>}
 */
export async function downloadVoice({ corpId, secret, mediaId }) {
  if (!corpId || !secret || !mediaId) {
    return { success: false, error: "corpId, secret and mediaId are required" };
  }

  try {
    // 确保临时目录存在
    if (!fs.existsSync(TEMP_VOICE_DIR)) {
      fs.mkdirSync(TEMP_VOICE_DIR, { recursive: true });
    }

    const accessToken = await getAccessToken(corpId, secret);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${accessToken}&media_id=${mediaId}`;

    logger.info("Downloading voice media", { mediaId });

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(60000), // 下载超时 60 秒
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        // 检查 Content-Type
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          // 返回的是 JSON 错误
          const data = await res.json();
          const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
          throw new Error(
            `Download failed: [${data.errcode}] ${errorInfo.message}`,
          );
        }

        return res;
      },
      {
        retries: 2,
        minTimeout: 1000,
        maxTimeout: 5000,
      },
    );

    const buffer = Buffer.from(await response.arrayBuffer());

    // 企业微信语音通常是 AMR 格式
    const filename = `voice_${Date.now()}_${mediaId.substring(0, 8)}.amr`;
    const localPath = path.join(TEMP_VOICE_DIR, filename);

    fs.writeFileSync(localPath, buffer);

    logger.info("Voice downloaded successfully", {
      localPath,
      size: buffer.length,
      mediaId,
    });

    return { success: true, localPath, size: buffer.length };
  } catch (error) {
    logger.error("Failed to download voice", {
      mediaId,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

/**
 * 清理过期的临时语音文件（超过1小时）
 */
export async function cleanupOldVoices() {
  try {
    if (!fs.existsSync(TEMP_VOICE_DIR)) return;

    const files = fs.readdirSync(TEMP_VOICE_DIR);
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(TEMP_VOICE_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > ONE_HOUR) {
        fs.unlinkSync(filePath);
        logger.debug("Cleaned up old voice file", { file });
      }
    }
  } catch (e) {
    // 忽略清理错误
  }
}

/**
 * 获取语音文件信息
 *
 * @param {string} filePath - 语音文件路径
 * @returns {Object} 语音文件信息
 */
export function getVoiceInfo(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false };
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  return {
    exists: true,
    path: filePath,
    size: stat.size,
    format: ext.replace(".", ""),
    createdAt: stat.birthtime,
    modifiedAt: stat.mtime,
  };
}

/**
 * 将语音转换为文本描述（用于 AI 理解）
 * 注意：这只是生成一个描述，实际语音转文字需要外部服务
 *
 * @param {Object} voiceInfo - 语音信息
 * @returns {string} 语音描述文本
 */
export function formatVoiceForAI(voiceInfo) {
  if (!voiceInfo.exists) {
    return "[用户发送了一条语音消息，但无法加载]";
  }

  const sizeKB = Math.round(voiceInfo.size / 1024);
  return `[用户发送了一条语音消息（${voiceInfo.format}格式，约${sizeKB}KB）。语音内容需要通过语音识别服务转换为文字。]`;
}

/**
 * 语音消息的占位处理
 * 当无法处理语音时，返回一个友好的提示
 *
 * @returns {string} 提示文本
 */
export function getVoiceNotSupportedMessage() {
  return "🎤 抱歉，目前暂不支持语音消息的处理。请发送文字消息与我交流。";
}
