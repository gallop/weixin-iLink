#!/usr/bin/env node
/**
 * 微信 ClawBot 发送消息脚本
 * 主动发送消息给指定用户
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(__dirname, "..", ".weixin-credentials.json");
const CONTEXT_TOKEN_PATH = path.join(__dirname, "..", ".weixin-context-tokens.json");

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

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error("❌ 未找到凭证文件，请先运行: node scripts/login.js");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
}

function loadContextTokens() {
  try {
    if (fs.existsSync(CONTEXT_TOKEN_PATH)) {
      return JSON.parse(fs.readFileSync(CONTEXT_TOKEN_PATH, "utf-8"));
    }
  } catch (e) {}
  return {};
}

function saveContextToken(userId, token) {
  const tokens = loadContextTokens();
  tokens[userId] = token;
  fs.writeFileSync(CONTEXT_TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

function getContextToken(userId) {
  const tokens = loadContextTokens();
  return tokens[userId];
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
  if (!response.ok) throw new Error(`API 错误: ${response.status}`);
  return await response.json();
}

async function sendTextMessage(baseUrl, token, toUserId, text, contextToken) {
  const clientId = generateClientId();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken || undefined,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: "1.0.3" },
  };

  console.log("📤 发送请求:", JSON.stringify(body, null, 2));

  const response = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  console.log(`📥 服务器响应: ${response.status} - ${responseText}`);

  if (!response.ok) {
    throw new Error(`发送失败: ${response.status} - ${responseText}`);
  }
  return { clientId, response: responseText };
}

async function sendTyping(baseUrl, token, userId, typingTicket) {
  if (!typingTicket) return;
  await fetch(`${baseUrl}/ilink/bot/sendtyping`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status: 1,
      base_info: { channel_version: "1.0.3" },
    }),
  });
}

async function getConfig(baseUrl, token, userId) {
  const response = await fetch(`${baseUrl}/ilink/bot/getconfig`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({
      ilink_user_id: userId,
      base_info: { channel_version: "1.0.3" },
    }),
  });
  if (!response.ok) return null;
  return await response.json();
}

function showHelp() {
  console.log(`
微信 ClawBot 发送消息脚本

用法:
  node scripts/send-message.js <userId> <message>
  node scripts/send-message.js -w <message>

参数:
  userId    目标用户 ID (格式: xxx@im.wechat)
  message   要发送的消息内容

选项:
  -l, --list     列出已知用户
  -w, --wait     等待对方发消息后再发送
  -h, --help     显示此帮助

示例:
  node scripts/send-message.js "abc123@im.wechat" "你好"
  node scripts/send-message.js -w "收到你的消息"
`);
}

async function sendNow(userId, message) {
  const credentials = loadCredentials();

  console.log(`📤 发送消息给: ${userId}`);
  console.log(`📝 内容: ${message}\n`);

  let contextToken = getContextToken(userId);
  if (!contextToken) {
    console.log("⚠️  未找到 context_token，尝试获取...\n");
    const result = await getUpdates(credentials.baseUrl, credentials.token, "");
    if (result.msgs?.length) {
      for (const msg of result.msgs) {
        if (msg.from_user_id === userId && msg.context_token) {
          contextToken = msg.context_token;
          saveContextToken(userId, contextToken);
          console.log("✅ 已获取 context_token\n");
          break;
        }
      }
    }
    if (!contextToken) {
      console.log("⚠️  无法获取 context_token，将尝试不带 token 发送（消息可能不会显示在对话中）\n");
    }
  }

  try {
    const config = await getConfig(credentials.baseUrl, credentials.token, userId);
    if (config?.typing_ticket) {
      await sendTyping(credentials.baseUrl, credentials.token, userId, config.typing_ticket);
      console.log("⌨️  正在输入...");
    }
    await sendTextMessage(credentials.baseUrl, credentials.token, userId, message, contextToken);
    console.log("✅ 发送成功！\n");
  } catch (error) {
    console.error("❌ 发送失败:", error.message);
    process.exit(1);
  }
}

async function waitForAndSend(message) {
  const credentials = loadCredentials();
  console.log("⏳ 等待对方发消息...\n");

  let getUpdatesBuf = "";
  while (true) {
    const result = await getUpdates(credentials.baseUrl, credentials.token, getUpdatesBuf);
    if (result.get_updates_buf) getUpdatesBuf = result.get_updates_buf;

    if (result.msgs?.length) {
      for (const msg of result.msgs) {
        if (msg.message_type === 1) {
          const userId = msg.from_user_id;
          const text = msg.item_list?.[0]?.text_item?.text || "";

          console.log(`📩 收到消息:`);
          console.log(`   来自: ${userId}`);
          console.log(`   内容: ${text}\n`);

          if (msg.context_token) saveContextToken(userId, msg.context_token);

          if (message) {
            console.log(`📤 发送回复: ${message}\n`);
            await sendTextMessage(credentials.baseUrl, credentials.token, userId, message, msg.context_token);
            console.log("✅ 发送成功！\n");
          }
          return;
        }
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    showHelp();
    process.exit(0);
  }

  if (args[0] === "-l" || args[0] === "--list") {
    const tokens = loadContextTokens();
    const users = Object.keys(tokens);
    if (users.length === 0) {
      console.log("暂无已知用户，请先让对方给你发消息");
    } else {
      console.log("已知用户:");
      users.forEach((u) => console.log(`  - ${u}`));
    }
    process.exit(0);
  }

  if (args[0] === "-w" || args[0] === "--wait") {
    await waitForAndSend(args[1]);
    return;
  }

  const [userId, ...messageParts] = args;
  const message = messageParts.join(" ");

  if (!userId || !message) {
    console.error("❌ 参数错误，用法: node scripts/send-message.js <userId> <message>");
    process.exit(1);
  }

  await sendNow(userId, message);
}

main();
