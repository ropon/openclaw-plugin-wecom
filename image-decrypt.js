import { createDecipheriv } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

/**
 * 解密企业微信 AI Bot 图片
 * 企业微信对图片使用 AES-256-CBC 加密，密钥与消息加密相同
 */

// 临时图片存储目录
const TEMP_IMAGE_DIR = "/tmp/wxwork_images";

/**
 * 下载并解密企业微信图片
 * @param {string} imageUrl - 加密的图片URL
 * @param {string} encodingAesKey - 企业微信的 EncodingAESKey
 * @returns {Promise<{success: boolean, localPath?: string, error?: string}>}
 */
export async function downloadAndDecryptImage(imageUrl, encodingAesKey) {
    if (!imageUrl || !encodingAesKey) {
        return { success: false, error: "Missing imageUrl or encodingAesKey" };
    }

    try {
        // 确保临时目录存在
        if (!existsSync(TEMP_IMAGE_DIR)) {
            mkdirSync(TEMP_IMAGE_DIR, { recursive: true });
        }

        // 下载加密图片
        logger.debug("Downloading encrypted image", { url: imageUrl.substring(0, 80) });
        const response = await fetch(imageUrl);
        if (!response.ok) {
            return { success: false, error: `Download failed: ${response.status}` };
        }

        const encryptedBuffer = Buffer.from(await response.arrayBuffer());
        
        // 检查是否是 XML 错误响应
        if (encryptedBuffer.toString("utf-8", 0, 5) === "<?xml") {
            return { success: false, error: "Image URL expired or access denied" };
        }

        // 解密
        const aesKey = Buffer.from(encodingAesKey + "=", "base64");
        const iv = aesKey.subarray(0, 16);

        const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
        decipher.setAutoPadding(false);
        const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);

        // 验证是否是有效图片 (JPEG: ff d8 ff, PNG: 89 50 4e 47)
        const header = decrypted.subarray(0, 4);
        const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
        const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;

        if (!isJpeg && !isPng) {
            logger.warn("Decrypted data is not a valid image", { header: header.toString("hex") });
            return { success: false, error: "Decrypted data is not a valid image" };
        }

        // 保存到临时文件
        const ext = isJpeg ? "jpg" : "png";
        const filename = `img_${Date.now()}.${ext}`;
        const localPath = join(TEMP_IMAGE_DIR, filename);
        writeFileSync(localPath, decrypted);

        logger.info("Image decrypted successfully", { localPath, size: decrypted.length });
        return { success: true, localPath };

    } catch (error) {
        logger.error("Failed to decrypt image", { error: error.message });
        return { success: false, error: error.message };
    }
}

/**
 * 清理过期的临时图片（超过1小时）
 */
export async function cleanupOldImages() {
    try {
        if (!existsSync(TEMP_IMAGE_DIR)) return;
        
        const { readdirSync, statSync, unlinkSync } = await import("node:fs");
        const files = readdirSync(TEMP_IMAGE_DIR);
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;

        for (const file of files) {
            const filePath = join(TEMP_IMAGE_DIR, file);
            const stat = statSync(filePath);
            if (now - stat.mtimeMs > ONE_HOUR) {
                unlinkSync(filePath);
                logger.debug("Cleaned up old image", { file });
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}
