#!/usr/bin/env node
/**
 * 微信 ClawBot 消息收发测试
 * 验证 token 是否有效，演示基础消息收发
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, "..", ".weixin-credentials.json");

function generateWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function generateClientId() {
  const id = crypto.randomBytes(8).toString("hex");
  return `openclaw-weixin-${id}`;
}

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": generateWechatUin(),
    Authorization: `Bearer ${token}`,
  };
}

async function getUpdates(baseUrl, token, getUpdatesBuf = "") {
  const response = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({
      get_updates_buf: getUpdatesBuf,
      base_info: { channel_version: "1.0.3" },
    }),
  });

  if (!response.ok) {
    throw new Error(`getUpdates 失败: ${response.status}`);
  }

  return await response.json();
}

async function sendMessage(baseUrl, token, toUserId, text, contextToken) {
  const clientId = generateClientId();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: "1.0.3" },
  };

  console.log(`   📤 发送请求:`, JSON.stringify(body, null, 2));

  const response = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  console.log(`   📥 服务器响应: ${response.status} - ${responseText}`);

  if (!response.ok) {
    throw new Error(`sendMessage 失败: ${response.status} - ${responseText}`);
  }

  return { clientId, response: responseText };
}

async function main() {
  console.log("=".repeat(50));
  console.log("  微信 ClawBot 连接测试");
  console.log("=".repeat(50));

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error("\n❌ 未找到凭证文件，请先运行登录脚本:");
    console.error("   node scripts/login.js\n");
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  console.log(`\n📋 已加载凭证:`);
  console.log(`   Bot ID:  ${credentials.botId}`);
  console.log(`   User ID: ${credentials.userId}`);

  try {
    console.log("\n🔍 测试连接...");
    const result = await getUpdates(credentials.baseUrl, credentials.token, "");

    // 调试：打印原始响应
    console.log("📦 服务器响应:", JSON.stringify(result, null, 2));

    // 判断成功：ret=0 或者没有错误码且有 msgs/get_updates_buf 字段
    const isSuccess = result.ret === 0 ||
      (result.errcode === undefined && result.errmsg === undefined);
    const isSessionExpired = result.errcode === -14;

    if (isSuccess) {
      console.log("✅ 连接成功！Token 有效\n");
    } else if (isSessionExpired) {
      console.log("❌ 会话已过期，请重新登录:");
      console.log("   node scripts/login.js\n");
      process.exit(1);
    } else {
      console.log(
        `⚠️  返回异常: ret=${result.ret ?? "undefined"} errcode=${result.errcode ?? "undefined"} errmsg=${result.errmsg ?? "undefined"}\n`,
      );
    }

    const msgCount = result.msgs?.length || 0;
    console.log(`📨 当前有 ${msgCount} 条待处理消息`);

    if (msgCount > 0) {
      console.log("\n消息列表:");
      for (const msg of result.msgs) {
        const from = msg.from_user_id || "未知";
        const type = msg.item_list?.[0]?.type || 0;
        const text = msg.item_list?.[0]?.text_item?.text || "(非文本)";
        console.log(
          `   [${type}] ${from}: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`,
        );
      }
    }

    console.log("\n" + "-".repeat(50));
    console.log("进入消息监听模式 (Ctrl+C 退出)");
    console.log("请从微信发送消息给 Bot，会自动回复");
    console.log("-".repeat(50) + "\n");

    let getUpdatesBuf = result.get_updates_buf || "";

    while (true) {
      const updates = await getUpdates(
        credentials.baseUrl,
        credentials.token,
        getUpdatesBuf,
      );

      if (updates.get_updates_buf) {
        getUpdatesBuf = updates.get_updates_buf;
      }

      if (updates.msgs?.length) {
        for (const msg of updates.msgs) {
          if (msg.message_type === 1) {
            const from = msg.from_user_id;
            const text = msg.item_list?.[0]?.text_item?.text || "";

            console.log(`📩 [${new Date().toLocaleTimeString()}] ${from}`);
            console.log(`   ${text}\n`);

            if (msg.context_token) {
              const reply = `🤖 gallop的接口测试脚本收到你的消息: "${text.substring(0, 30)}${text.length > 30 ? "..." : ""}"`;
              const result = await sendMessage(
                credentials.baseUrl,
                credentials.token,
                from,
                reply,
                msg.context_token,
              );
              console.log(`   ↩️  已回复 (clientId: ${result.clientId}): ${reply}\n`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    process.exit(1);
  }
}

main();
