/**
 * 企业微信通讯录 API 客户端
 * 用于获取成员详细信息（姓名、部门、职位等）
 * https://developer.work.weixin.qq.com/document/path/90196
 */

import { logger } from "./logger.js";
import { withRetry, parseWxWorkError, CONSTANTS } from "./utils.js";

// Access Token 缓存
let accessTokenCache = {
  token: null,
  expiresAt: 0,
};

// 用户信息缓存 (userid -> userInfo)
const userInfoCache = new Map();

// 部门列表缓存
let departmentCache = {
  list: null,
  expiresAt: 0,
};

// 全员列表缓存（用于按名字搜索）
let allUsersCache = {
  list: null,
  expiresAt: 0,
};

// 缓存配置
const CACHE_CONFIG = {
  USER_INFO_TTL: 3600 * 1000, // 用户信息缓存 1 小时
  ACCESS_TOKEN_BUFFER: 300 * 1000, // access_token 提前 5 分钟刷新
  DEPARTMENT_TTL: 3600 * 1000, // 部门列表缓存 1 小时
  ALL_USERS_TTL: 1800 * 1000, // 全员列表缓存 30 分钟
};

/**
 * 获取企业微信 access_token
 * https://developer.work.weixin.qq.com/document/path/91039
 */
async function getAccessToken(corpId, secret, forceRefresh = false) {
  // 检查缓存
  const now = Date.now();
  if (
    !forceRefresh &&
    accessTokenCache.token &&
    accessTokenCache.expiresAt > now
  ) {
    logger.debug("Using cached access_token", {
      expiresIn: Math.floor((accessTokenCache.expiresAt - now) / 1000),
    });
    return accessTokenCache.token;
  }

  logger.info("Fetching new access_token from WxWork API");

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(
    corpId,
  )}&corpsecret=${encodeURIComponent(secret)}`;

  const response = await withRetry(
    async () => {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(CONSTANTS.WEBHOOK_RESPONSE_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.errcode !== 0) {
        const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
        throw new Error(
          `Get access_token failed: [${data.errcode}] ${errorInfo.message}`,
        );
      }

      return data;
    },
    {
      retries: 2,
      minTimeout: 500,
      maxTimeout: 2000,
      onRetry: (error, attempt) => {
        logger.warn(`Get access_token retry ${attempt}/2`, {
          error: error.message,
        });
      },
    },
  );

  // 缓存 token (提前 5 分钟过期，避免边界问题)
  accessTokenCache = {
    token: response.access_token,
    expiresAt: now + (response.expires_in - 300) * 1000,
  };

  logger.info("Access token obtained", {
    expiresIn: response.expires_in,
  });

  return response.access_token;
}

/**
 * 获取成员详细信息
 * https://developer.work.weixin.qq.com/document/path/90196
 */
async function getUserInfo(corpId, secret, userid, useCache = true) {
  if (!corpId || !secret) {
    logger.warn("CorpId or Secret not configured, skipping user info fetch");
    return null;
  }

  if (!userid) {
    logger.warn("UserId is empty, cannot fetch user info");
    return null;
  }

  // 检查缓存
  if (useCache && userInfoCache.has(userid)) {
    const cached = userInfoCache.get(userid);
    const now = Date.now();
    if (cached.expiresAt > now) {
      logger.debug("Using cached user info", {
        userid,
        name: cached.data.name,
        expiresIn: Math.floor((cached.expiresAt - now) / 1000),
      });
      return cached.data;
    }
    // 缓存过期，删除
    userInfoCache.delete(userid);
  }

  try {
    const accessToken = await getAccessToken(corpId, secret);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${accessToken}&userid=${encodeURIComponent(
      userid,
    )}`;

    logger.debug("Fetching user info from WxWork API", { userid });

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(CONSTANTS.WEBHOOK_RESPONSE_TIMEOUT_MS),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();

        if (data.errcode !== 0) {
          const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
          throw new Error(
            `Get user info failed: [${data.errcode}] ${errorInfo.message}`,
          );
        }

        return data;
      },
      {
        retries: 2,
        minTimeout: 500,
        maxTimeout: 2000,
        onRetry: (error, attempt) => {
          logger.warn(`Get user info retry ${attempt}/2`, {
            error: error.message,
            userid,
          });
        },
      },
    );

    // 提取关键信息
    const userInfo = {
      userid: response.userid,
      name: response.name || userid, // 姓名
      alias: response.alias || "", // 别名
      position: response.position || "", // 职位
      department: response.department || [], // 部门ID列表
      mobile: response.mobile || "", // 手机号
      email: response.email || "", // 邮箱
      avatar: response.avatar || "", // 头像
      status: response.status || 1, // 激活状态: 1=已激活 2=已禁用 4=未激活
      gender:
        response.gender === "1"
          ? "男"
          : response.gender === "2"
            ? "女"
            : "未知",
    };

    // 缓存用户信息
    userInfoCache.set(userid, {
      data: userInfo,
      expiresAt: Date.now() + CACHE_CONFIG.USER_INFO_TTL,
    });

    logger.info("User info fetched successfully", {
      userid,
      name: userInfo.name,
      position: userInfo.position,
    });

    return userInfo;
  } catch (error) {
    logger.error("Failed to fetch user info", {
      userid,
      error: error.message,
    });
    // 返回基础信息（仅包含 userid）
    return {
      userid,
      name: userid, // 降级使用 userid 作为名称
      alias: "",
      position: "",
      department: [],
      mobile: "",
      email: "",
      avatar: "",
      status: 1,
      gender: "未知",
    };
  }
}

/**
 * 批量获取成员信息
 * @param {string} corpId - 企业ID
 * @param {string} secret - 应用密钥
 * @param {string[]} userids - 用户ID列表
 * @param {boolean} useCache - 是否使用缓存
 * @returns {Promise<Map<string, Object>>} userid -> userInfo 映射
 */
async function batchGetUserInfo(corpId, secret, userids, useCache = true) {
  const results = new Map();

  // 并发获取所有用户信息（限制并发数为 5）
  const chunkSize = 5;
  for (let i = 0; i < userids.length; i += chunkSize) {
    const chunk = userids.slice(i, i + chunkSize);
    const promises = chunk.map((userid) =>
      getUserInfo(corpId, secret, userid, useCache),
    );

    const infos = await Promise.all(promises);
    infos.forEach((info, idx) => {
      if (info) {
        results.set(chunk[idx], info);
      }
    });
  }

  return results;
}

/**
 * 获取部门列表
 * https://developer.work.weixin.qq.com/document/path/90208
 */
async function getDepartmentList(corpId, secret, useCache = true) {
  const now = Date.now();
  
  // 检查缓存
  if (useCache && departmentCache.list && departmentCache.expiresAt > now) {
    logger.debug("Using cached department list", {
      count: departmentCache.list.length,
    });
    return departmentCache.list;
  }

  const accessToken = await getAccessToken(corpId, secret);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${accessToken}`;

  const response = await withRetry(
    async () => {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(CONSTANTS.WEBHOOK_RESPONSE_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.errcode !== 0) {
        const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
        throw new Error(
          `Get department list failed: [${data.errcode}] ${errorInfo.message}`,
        );
      }

      return data;
    },
    {
      retries: 2,
      minTimeout: 500,
      maxTimeout: 2000,
    },
  );

  // 缓存部门列表
  departmentCache = {
    list: response.department,
    expiresAt: now + CACHE_CONFIG.DEPARTMENT_TTL,
  };

  logger.info("Department list fetched", { count: response.department.length });
  return response.department;
}

/**
 * 获取部门成员（简要信息）
 * https://developer.work.weixin.qq.com/document/path/90200
 */
async function getDepartmentUsers(corpId, secret, departmentId) {
  const accessToken = await getAccessToken(corpId, secret);
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/simplelist?access_token=${accessToken}&department_id=${departmentId}`;

  const response = await withRetry(
    async () => {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(CONSTANTS.WEBHOOK_RESPONSE_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();

      if (data.errcode !== 0) {
        const errorInfo = parseWxWorkError(data.errcode, data.errmsg);
        throw new Error(
          `Get department users failed: [${data.errcode}] ${errorInfo.message}`,
        );
      }

      return data;
    },
    {
      retries: 2,
      minTimeout: 500,
      maxTimeout: 2000,
    },
  );

  return response.userlist || [];
}

/**
 * 获取所有成员列表（遍历所有部门）
 * 用于按名字搜索
 */
async function getAllUsers(corpId, secret, useCache = true) {
  const now = Date.now();

  // 检查缓存
  if (useCache && allUsersCache.list && allUsersCache.expiresAt > now) {
    logger.debug("Using cached all users list", {
      count: allUsersCache.list.length,
    });
    return allUsersCache.list;
  }

  logger.info("Fetching all users from all departments");

  const departments = await getDepartmentList(corpId, secret, useCache);
  const userMap = new Map(); // 用 Map 去重（按 userid）

  // 并发获取所有部门的成员（限制并发数）
  const chunkSize = 5;
  for (let i = 0; i < departments.length; i += chunkSize) {
    const chunk = departments.slice(i, i + chunkSize);
    const promises = chunk.map((dept) =>
      getDepartmentUsers(corpId, secret, dept.id).catch((err) => {
        logger.warn(`Failed to get users for department ${dept.id}`, {
          error: err.message,
        });
        return [];
      }),
    );

    const results = await Promise.all(promises);
    results.forEach((users, idx) => {
      const dept = chunk[idx];
      users.forEach((user) => {
        if (!userMap.has(user.userid)) {
          userMap.set(user.userid, {
            userid: user.userid,
            name: user.name,
            department: user.department,
            departmentName: dept.name,
          });
        }
      });
    });
  }

  const allUsers = Array.from(userMap.values());

  // 缓存全员列表
  allUsersCache = {
    list: allUsers,
    expiresAt: now + CACHE_CONFIG.ALL_USERS_TTL,
  };

  logger.info("All users fetched", { count: allUsers.length });
  return allUsers;
}

/**
 * 按名字搜索用户
 * 支持模糊匹配（包含即可）
 * 
 * @param {string} corpId - 企业ID
 * @param {string} secret - 应用密钥
 * @param {string} name - 要搜索的名字（支持部分匹配）
 * @returns {Promise<Array>} 匹配的用户列表 [{userid, name, department, departmentName}]
 */
async function searchUserByName(corpId, secret, name) {
  if (!name || !name.trim()) {
    return [];
  }

  const searchName = name.trim();
  const allUsers = await getAllUsers(corpId, secret);

  const matches = allUsers.filter((user) =>
    user.name && user.name.includes(searchName)
  );

  logger.info("User search completed", {
    query: searchName,
    found: matches.length,
  });

  return matches;
}

/**
 * 手动清除缓存
 */
function clearCache() {
  accessTokenCache = { token: null, expiresAt: 0 };
  userInfoCache.clear();
  departmentCache = { list: null, expiresAt: 0 };
  allUsersCache = { list: null, expiresAt: 0 };
  logger.info("Contact API cache cleared");
}

/**
 * 获取缓存统计信息
 */
function getCacheStats() {
  return {
    accessToken: {
      cached: !!accessTokenCache.token,
      expiresAt: accessTokenCache.expiresAt,
      expiresIn: Math.max(
        0,
        Math.floor((accessTokenCache.expiresAt - Date.now()) / 1000),
      ),
    },
    userInfo: {
      count: userInfoCache.size,
      users: Array.from(userInfoCache.keys()),
    },
  };
}

export {
  getUserInfo,
  batchGetUserInfo,
  getAccessToken,
  clearCache,
  getCacheStats,
  getDepartmentList,
  getDepartmentUsers,
  getAllUsers,
  searchUserByName,
};
