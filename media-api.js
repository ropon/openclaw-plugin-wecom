/**
 * 企业微信素材管理 API
 * 用于上传临时素材（图片、语音、视频、文件）
 * https://developer.work.weixin.qq.com/document/path/90253
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import { withRetry, parseWxWorkError, CONSTANTS } from "./utils.js";
import { getAccessToken } from "./contact-api.js";

// Media ID 缓存 (filePath -> { mediaId, expiresAt })
// 临时素材有效期为3天，我们缓存2天
const mediaCache = new Map();
const MEDIA_CACHE_TTL = 2 * 24 * 3600 * 1000; // 2天

/**
 * 获取文件的 MIME 类型
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".amr": "audio/amr",
    ".mp3": "audio/mp3",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".txt": "text/plain",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * 根据 MIME 类型判断素材类型
 */
function getMediaType(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "voice";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

/**
 * 上传临时素材
 * https://developer.work.weixin.qq.com/document/path/90253
 *
 * @param {Object} params
 * @param {string} params.corpId - 企业ID
 * @param {string} params.secret - 应用密钥
 * @param {string} params.filePath - 文件路径
 * @param {string} [params.type] - 素材类型 (image/voice/video/file)，不指定则自动判断
 * @param {boolean} [params.useCache=true] - 是否使用缓存
 * @returns {Promise<string>} media_id
 */
async function uploadMedia({
  corpId,
  secret,
  filePath,
  type,
  useCache = true,
}) {
  if (!corpId || !secret) {
    throw new Error("corpId and secret are required");
  }

  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  // 检查缓存
  const cacheKey = absolutePath;
  if (useCache && mediaCache.has(cacheKey)) {
    const cached = mediaCache.get(cacheKey);
    if (cached.expiresAt > Date.now()) {
      logger.debug("Using cached media_id", {
        filePath: absolutePath,
        mediaId: cached.mediaId,
        expiresIn:
          Math.floor((cached.expiresAt - Date.now()) / 1000 / 3600) + "h",
      });
      return cached.mediaId;
    }
    // 缓存过期
    mediaCache.delete(cacheKey);
  }

  const mimeType = getMimeType(absolutePath);
  const mediaType = type || getMediaType(mimeType);
  const fileName = path.basename(absolutePath);

  logger.info("Uploading media to WxWork", {
    filePath: absolutePath,
    fileName,
    mimeType,
    mediaType,
  });

  const accessToken = await getAccessToken(corpId, secret);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=${mediaType}`;

  const response = await withRetry(
    async () => {
      const fileBuffer = fs.readFileSync(absolutePath);

      // 构建 FormData
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append("media", blob, fileName);

      const res = await fetch(url, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(60000), // 上传超时 60 秒
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.errcode && data.errcode !== 0) {
        const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
        throw new Error(
          `Upload media failed: [${data.errcode}] ${errorInfo.message}`,
        );
      }

      return data;
    },
    {
      retries: 2,
      minTimeout: 1000,
      maxTimeout: 5000,
      onRetry: (error, attempt) => {
        logger.warn(`Upload media retry ${attempt}/2`, {
          error: error.message,
          filePath: absolutePath,
        });
      },
    },
  );

  logger.info("Media uploaded successfully", {
    filePath: absolutePath,
    mediaId: response.media_id,
    type: response.type,
    createdAt: response.created_at,
  });

  // 缓存 media_id
  mediaCache.set(cacheKey, {
    mediaId: response.media_id,
    expiresAt: Date.now() + MEDIA_CACHE_TTL,
  });

  return response.media_id;
}

/**
 * 上传图片素材（便捷方法）
 */
async function uploadImage({ corpId, secret, filePath, useCache = true }) {
  return uploadMedia({ corpId, secret, filePath, type: "image", useCache });
}

/**
 * 清除媒体缓存
 */
function clearMediaCache() {
  mediaCache.clear();
  logger.info("Media cache cleared");
}

/**
 * 获取媒体缓存统计
 */
function getMediaCacheStats() {
  const now = Date.now();
  const entries = [];

  for (const [key, value] of mediaCache.entries()) {
    entries.push({
      filePath: key,
      mediaId: value.mediaId,
      expiresIn: Math.floor((value.expiresAt - now) / 1000 / 3600) + "h",
    });
  }

  return {
    count: mediaCache.size,
    entries,
  };
}

/**
 * 下载临时素材
 * https://developer.work.weixin.qq.com/document/path/90254
 *
 * @param {Object} params
 * @param {string} params.corpId - 企业ID
 * @param {string} params.secret - 应用密钥
 * @param {string} params.mediaId - 媒体文件ID
 * @param {string} [params.saveDir] - 保存目录，默认 /tmp/wxwork_media
 * @returns {Promise<{success: boolean, localPath?: string, mimeType?: string, size?: number, error?: string}>}
 */
async function downloadMedia({
  corpId,
  secret,
  mediaId,
  saveDir = "/tmp/wxwork_media",
}) {
  if (!corpId || !secret || !mediaId) {
    return { success: false, error: "corpId, secret and mediaId are required" };
  }

  try {
    // 确保保存目录存在
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    const accessToken = await getAccessToken(corpId, secret);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${accessToken}&media_id=${mediaId}`;

    logger.info("Downloading media from WxWork", { mediaId });

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(120000), // 下载超时 120 秒
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        // 检查 Content-Type 是否是 JSON（错误响应）
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
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

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());

    // 根据 Content-Type 确定文件扩展名
    const extMap = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "audio/amr": "amr",
      "audio/mpeg": "mp3",
      "video/mp4": "mp4",
      "application/pdf": "pdf",
    };

    const ext = extMap[contentType] || "bin";
    const filename = `media_${Date.now()}_${mediaId.substring(0, 8)}.${ext}`;
    const localPath = path.join(saveDir, filename);

    fs.writeFileSync(localPath, buffer);

    logger.info("Media downloaded successfully", {
      localPath,
      size: buffer.length,
      mimeType: contentType,
      mediaId,
    });

    return {
      success: true,
      localPath,
      mimeType: contentType,
      size: buffer.length,
    };
  } catch (error) {
    logger.error("Failed to download media", {
      mediaId,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

/**
 * 下载图片素材（便捷方法）
 *
 * @param {Object} params
 * @param {string} params.corpId - 企业ID
 * @param {string} params.secret - 应用密钥
 * @param {string} params.mediaId - 图片的media_id
 * @param {string} [params.saveDir] - 保存目录
 * @returns {Promise<{success: boolean, localPath?: string, error?: string}>}
 */
async function downloadImage({
  corpId,
  secret,
  mediaId,
  saveDir = "/tmp/wxwork_images",
}) {
  return downloadMedia({ corpId, secret, mediaId, saveDir });
}

/**
 * 清理过期的临时媒体文件
 *
 * @param {string} dir - 媒体目录
 * @param {number} maxAgeMs - 最大保留时间（毫秒），默认 1 小时
 */
async function cleanupTempMedia(
  dir = "/tmp/wxwork_media",
  maxAgeMs = 3600 * 1000,
) {
  try {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        logger.debug("Cleaned up temp media file", { file });
      }
    }
  } catch (e) {
    // 忽略清理错误
  }
}

export {
  uploadMedia,
  uploadImage,
  downloadMedia,
  downloadImage,
  clearMediaCache,
  getMediaCacheStats,
  getMimeType,
  getMediaType,
  cleanupTempMedia,
};
