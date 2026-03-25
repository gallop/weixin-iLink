#!/usr/bin/env node
/**
 * 微信 ClawBot 登录脚本
 * 通过二维码扫码获取 bot_token
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  baseUrl: "https://ilinkai.weixin.qq.com",
  botType: "3",
  pollInterval: 1000,
  qrTimeout: 300000,
  credentialsPath: path.join(__dirname, "..", ".weixin-credentials.json"),
};

async function fetchQRCode() {
  const url = `${CONFIG.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${CONFIG.botType}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`获取二维码失败: ${response.status}`);
  }
  const data = await response.json();
  return {
    qrcode: data.qrcode,
    qrcodeUrl: data.qrcode_img_content,
  };
}

async function pollQRStatus(qrcode) {
  const url = `${CONFIG.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const response = await fetch(url, {
    headers: { "iLink-App-ClientVersion": "1" },
  });
  if (!response.ok) {
    throw new Error(`轮询状态失败: ${response.status}`);
  }
  return await response.json();
}

function saveCredentials(data) {
  const credentials = {
    token: data.bot_token,
    baseUrl: data.baseurl || CONFIG.baseUrl,
    botId: data.ilink_bot_id,
    userId: data.ilink_user_id,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG.credentialsPath, JSON.stringify(credentials, null, 2), "utf-8");
  try {
    fs.chmodSync(CONFIG.credentialsPath, 0o600);
  } catch (e) {}
  return credentials;
}

function loadCredentials() {
  try {
    if (fs.existsSync(CONFIG.credentialsPath)) {
      return JSON.parse(fs.readFileSync(CONFIG.credentialsPath, "utf-8"));
    }
  } catch (e) {}
  return null;
}

/**
 * 快速生成 ASCII 二维码
 */
async function generateQRCode(text) {
  // 使用 qrcode 包生成紧凑的 ASCII 二维码
  const qr = await QRCode.toString(text, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'L',  // 低纠错，生成更小的二维码
    margin: 1,
  });
  return qr;
}

async function login() {
  console.log("=".repeat(50));
  console.log("  微信 ClawBot 登录");
  console.log("=".repeat(50));

  const existing = loadCredentials();
  if (existing?.token) {
    console.log(`\n⚠️  已保存凭证: ${existing.botId}`);
    console.log(`   保存时间: ${existing.savedAt}`);
    console.log(`   重新登录请删除: ${CONFIG.credentialsPath}\n`);
  }

  try {
    // 并行获取二维码和生成二维码图像
    console.log("\n📌 获取登录二维码...");

    const { qrcode: qrCode, qrcodeUrl } = await fetchQRCode();

    // 快速生成 ASCII 二维码
    const qrString = await generateQRCode(qrcodeUrl);

    console.log("\n📱 微信扫码登录：\n");
    console.log(qrString);
    console.log("⏳ 等待扫码确认...\n");

    const startTime = Date.now();
    let scanned = false;

    while (Date.now() - startTime < CONFIG.qrTimeout) {
      const status = await pollQRStatus(qrCode);

      switch (status.status) {
        case "wait":
          process.stdout.write(".");
          break;

        case "scaned":
          if (!scanned) {
            console.log("\n\n👀 已扫码，请在微信确认...");
            scanned = true;
          }
          break;

        case "expired":
          console.log("\n\n⏳ 二维码已过期，请重新运行");
          process.exit(1);

        case "confirmed":
          console.log("\n\n✅ 登录成功！\n");
          console.log("-".repeat(50));
          const credentials = saveCredentials(status);
          console.log("📋 凭证信息:");
          console.log(`   Bot ID:     ${credentials.botId}`);
          console.log(`   User ID:    ${credentials.userId}`);
          console.log(`   Token:      ${credentials.token.substring(0, 20)}...`);
          console.log(`\n📁 已保存到: ${CONFIG.credentialsPath}`);
          console.log("-".repeat(50));
          return credentials;
      }

      await new Promise((r) => setTimeout(r, CONFIG.pollInterval));
    }

    console.log("\n\n⏰ 登录超时，请重新运行");
    process.exit(1);

  } catch (error) {
    console.error("\n\n❌ 登录失败:", error.message);
    process.exit(1);
  }
}

login();
