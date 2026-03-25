# 微信 ClawBot 插件 (iLink Bot API) 源码分析与关键技术点

## 源码结构

```
openclaw-weixin-1.0.3/package/
├── src/
│   ├── api/                    # iLink API 封装
│   │   ├── api.ts              # HTTP 请求封装、鉴权头构建
│   │   ├── types.ts            # 完整类型定义
│   │   ├── config-cache.ts     # 配置缓存
│   │   └── session-guard.ts    # 会话过期保护
│   ├── auth/                   # 登录鉴权
│   │   ├── accounts.ts         # 账号存储、多账号管理
│   │   ├── login-qr.ts         # 二维码登录流程
│   │   └── pairing.ts          # 配对授权
│   ├── cdn/                    # CDN 媒体处理
│   │   ├── aes-ecb.ts          # AES-128-ECB 加解密
│   │   ├── cdn-upload.ts       # CDN 上传（带重试）
│   │   ├── cdn-url.ts          # CDN URL 构建
│   │   ├── upload.ts           # 统一上传管道
│   │   └── pic-decrypt.ts      # 图片解密
│   ├── messaging/              # 消息处理
│   │   ├── inbound.ts          # 入站消息转换、context_token 管理
│   │   ├── send.ts             # 发送消息（文本/图片/视频/文件）
│   │   ├── send-media.ts       # 媒体消息发送
│   │   └── process-message.ts  # 消息处理管道
│   ├── monitor/
│   │   └── monitor.ts          # 长轮询主循环
│   ├── media/
│   │   ├── media-download.ts   # 媒体下载
│   │   ├── silk-transcode.ts   # SILK 语音转码
│   │   └── mime.ts             # MIME 类型处理
│   └── storage/
│       ├── state-dir.ts        # 状态目录
│       └── sync-buf.ts         # get_updates_buf 持久化
```

## 关键技术点

### 1. 鉴权机制

**X-WECHAT-UIN 生成** (`src/api/api.ts:62-66`)
```typescript
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}
```
- 随机 uint32 → 十进制字符串 → Base64 编码
- 每次请求都变化，防重放攻击

**请求头模板**
```http
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <base64随机UIN>
Authorization: Bearer <bot_token>
```

### 2. 二维码登录流程 (`src/auth/login-qr.ts`)

```
startWeixinLoginWithQr() ──▶ fetchQRCode()
         │                        │
         │                        ▼
         │              GET /ilink/bot/get_bot_qrcode?bot_type=3
         │                        │
         ◀────────────────────────┘
         │
         ▼
waitForWeixinLogin() ──▶ pollQRStatus() (长轮询 35s)
         │                        │
         │                        ▼
         │              GET /ilink/bot/get_qrcode_status?qrcode=xxx
         │                        │
         │         ┌──────────────┼──────────────┐
         │         ▼              ▼              ▼
         │      "wait"      "scaned"      "confirmed"
         │                                    │
         │                              返回 bot_token
         │                              返回 ilink_bot_id
         │                              返回 baseurl
```

- **bot_type=3**: 硬编码，对应特定账号类型
- **QR 过期自动刷新**: 最多 3 次
- **登录超时**: 默认 480s

### 3. context_token 机制 (`src/messaging/inbound.ts`)

**核心设计**:
- 每条入站消息都带有 `context_token`
- 回复时**必须原样带上**，否则消息不会关联到正确对话
- 支持内存缓存 + 磁盘持久化（重启不丢失）

```typescript
// 存储结构: Map<accountId:userId, contextToken>
const contextTokenStore = new Map<string, string>();

// 持久化路径
~/.openclaw/openclaw-weixin/accounts/{accountId}.context-tokens.json
```

### 4. 长轮询消息收取 (`src/monitor/monitor.ts`)

**超时配置**:
```typescript
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;  // 35秒
const MAX_CONSECUTIVE_FAILURES = 3;            // 最大连续失败
const BACKOFF_DELAY_MS = 30_000;               // 退避延迟
```

**游标机制**:
- `get_updates_buf` 类似数据库 cursor
- 必须每次更新，否则重复收到消息
- 自动持久化到磁盘

**会话过期处理**:
- errcode = -14 表示会话过期
- 自动暂停请求，等待恢复

### 5. CDN 媒体加密 (`src/cdn/`)

**加密算法**: AES-128-ECB + PKCS7 填充

```typescript
// 加密 (src/cdn/aes-ecb.ts)
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

// 密文大小计算 (PKCS7 填充到 16 字节边界)
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
```

**CDN URL 构建** (`src/cdn/cdn-url.ts`):
```typescript
// 下载 URL
`${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(param)}`

// 上传 URL
`${cdnBaseUrl}/upload?encrypted_query_param=${param}&filekey=${filekey}`
```

**上传流程** (`src/cdn/upload.ts`):
1. 读取文件 → 计算 MD5
2. 生成随机 AES-128 key
3. 调用 `getUploadUrl` 获取预签名 URL
4. AES-128-ECB 加密文件
5. POST 到 CDN（最多 3 次重试）
6. 从响应头 `x-encrypted-param` 获取下载参数

### 6. 消息类型支持 (`src/api/types.ts`)

| type | 类型 | 结构体 |
|------|------|--------|
| 1 | TEXT | `TextItem { text }` |
| 2 | IMAGE | `ImageItem { media, thumb_media, aeskey, mid_size, ... }` |
| 3 | VOICE | `VoiceItem { media, encode_type, sample_rate, playtime, text }` |
| 4 | FILE | `FileItem { media, file_name, md5, len }` |
| 5 | VIDEO | `VideoItem { media, thumb_media, video_size, play_length, ... }` |

**语音编码类型**:
```typescript
// encode_type: 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex
```

### 7. 多账号管理 (`src/auth/accounts.ts`)

**账号数据结构**:
```typescript
type WeixinAccountData = {
  token?: string;       // Bearer token
  baseUrl?: string;     // API 基础 URL
  userId?: string;      // 微信用户 ID
  savedAt?: string;     // 保存时间
};
```

**存储路径**:
```
~/.openclaw/
├── openclaw-weixin/
│   ├── accounts.json              # 账号索引
│   └── accounts/
│       ├── {accountId}.json       # 账号凭证
│       ├── {accountId}.sync.json  # 同步游标
│       └── {accountId}.context-tokens.json
```

**同 userId 账号去重**:
- 新登录后自动清理同 userId 的旧账号
- 防止 context_token 匹配歧义

### 8. Markdown 转纯文本 (`src/messaging/send.ts`)

```typescript
function markdownToPlainText(text: string): string {
  // 代码块: 移除 fence，保留代码内容
  // 图片: 完全移除
  // 链接: 保留显示文本
  // 表格: 转为空格分隔
  return stripMarkdown(result);
}
```

### 9. 默认配置

```typescript
// API 基础 URL
DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"

// CDN 基础 URL
CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
```

## 协议核心能力

### 1. 消息类型支持

| type | 类型 | 说明 |
|------|------|------|
| 1 | 文本 | 纯文本消息 |
| 2 | 图片 | CDN 加密存储，AES-128-ECB |
| 3 | 语音 | SILK 编码，附带转文字结果 |
| 4 | 文件 | 通用文件附件 |
| 5 | 视频 | 视频消息 |

### 2. API 端点列表

| 端点 | 方法 | 功能 |
|------|------|------|
| `/ilink/bot/get_bot_qrcode` | GET | 获取登录二维码 (`?bot_type=3`) |
| `/ilink/bot/get_qrcode_status` | GET | 轮询扫码状态 (`?qrcode=xxx`) |
| `/ilink/bot/getupdates` | POST | **长轮询收消息**（核心，35s 超时） |
| `/ilink/bot/sendmessage` | POST | 发送消息（文字/图片/文件/视频/语音） |
| `/ilink/bot/getuploadurl` | POST | 获取 CDN 预签名上传地址 |
| `/ilink/bot/getconfig` | POST | 获取 typing_ticket |
| `/ilink/bot/sendtyping` | POST | 发送"正在输入"状态 |

CDN 域名：`https://novac2c.cdn.weixin.qq.com/c2c`

### 3. 鉴权机制

```http
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: base64(String(randomUint32()))  # 每次随机
Authorization: Bearer ${bot_token}             # 登录后获取
```

### 4. 关键设计

- **context_token**: 每条消息都带有，回复时**必须原样带上**，否则消息不会关联到正确对话
- **get_updates_buf**: 类似数据库游标，必须每次更新，否则会重复收到消息
- **消息 ID 格式**: 用户 `xxx@im.wechat`，Bot `xxx@im.bot`

## 媒体文件处理

所有媒体文件通过 CDN 传输，使用 **AES-128-ECB** 加密：

1. 生成随机 AES-128 key
2. 用 AES-128-ECB 加密文件
3. 调用 `getuploadurl` 获取预签名 URL
4. PUT 加密文件到 CDN
5. 在 `sendmessage` 中带上 `aes_key`（base64）和 CDN 引用参数

## 可以构建的应用

| 场景 | 描述 |
|------|------|
| **个人 AI 助手** | 在微信里使用 Claude / GPT |
| **通知机器人** | 监控报警、部署状态推送到微信 |
| **客服系统** | 多账号管理 + 自动分流 |
| **工作流自动化** | 接收微信指令触发 CI/CD、文件处理等 |
| **家庭群助手** | 家庭群内的 AI 助手 |
| **个人知识库** | 发消息自动归档到 Notion/飞书 |

## 技术限制

1. **bot_type=3 含义未完全明确** — 可能对应特定账号类型
2. **需要 OpenClaw 账号体系** — 需要通过平台审核或注册
3. **群聊支持** — 有 `group_id` 字段，可能需要额外权限
4. **无历史消息 API** — 只有 `get_updates_buf` 游标机制
5. **速率限制未公开** — 需要实测

## 相关资源

| 资源 | 链接 |
|------|------|
| npm 包 | `@tencent-weixin/openclaw-weixin` |
| CLI 工具 | `@tencent-weixin/openclaw-weixin-cli` |
| 逆向分析文档 | https://github.com/hao-ji-xing/openclaw-weixin |
| npm 页面 | https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin |

## 安装方式

```bash
# 快速安装
npx -y @tencent-weixin/openclaw-weixin-cli install

# 手动安装
openclaw plugins install "@tencent-weixin/openclaw-weixin"
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw channels login --channel openclaw-weixin
openclaw gateway restart
```

## 官方条款要点

- 腾讯只是"管道"，不存储消息内容，不提供 AI 服务
- 腾讯保留限速、封禁、终止服务的权利
- IP、操作记录、设备信息会被收集用于安全审计
- 不应将核心业务完全依赖这套 API

---

## 协议栈详解

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
│  iLink Bot Protocol (JSON over HTTP)                    │
│  - 消息收发 API                                          │
│  - 鉴权/登录 API                                         │
│  - 配置/状态 API                                         │
├─────────────────────────────────────────────────────────┤
│                    Media Layer                           │
│  CDN Protocol (HTTPS)                                   │
│  - AES-128-ECB 加密传输                                  │
│  - 预签名 URL 上传/下载                                  │
├─────────────────────────────────────────────────────────┤
│                    Transport Layer                       │
│  HTTPS (TLS 1.2+)                                       │
│  - ilinkai.weixin.qq.com                                │
│  - novac2c.cdn.weixin.qq.com                            │
└─────────────────────────────────────────────────────────┘
```

### 协议 1: iLink Bot API

**类型**: RESTful JSON over HTTP

**请求格式**:
```http
POST /ilink/bot/{endpoint} HTTP/1.1
Host: ilinkai.weixin.qq.com
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <base64随机UIN>
Authorization: Bearer <bot_token>

{"get_updates_buf": "", "base_info": {"channel_version": "1.0.3"}}
```

**错误码**:
| errcode | 含义 |
|---------|------|
| 0 | 成功 |
| -14 | 会话过期，需暂停请求 |

### 协议 2: CDN 媒体协议

**上传流程**:
```
1. POST /ilink/bot/getuploadurl → 获取 upload_param
2. POST https://novac2c.cdn.weixin.qq.com/c2c/upload
   ?encrypted_query_param={upload_param}&filekey={filekey}
   Body: AES-128-ECB 加密的文件内容
   Response Header: x-encrypted-param → download_param
3. 发送消息时使用 download_param
```

**下载流程**:
```
GET https://novac2c.cdn.weixin.qq.com/c2c/download
    ?encrypted_query_param={encrypt_query_param}
Response: AES-128-ECB 加密的文件内容
需要用 aes_key 解密
```

### 协议 3: 语音编码

| encode_type | 格式 | 说明 |
|-------------|------|------|
| 1 | PCM | 原始 PCM |
| 5 | AMR | 移动端常用 |
| 6 | SILK | **微信默认格式** |
| 7 | MP3 | 通用格式 |

**语音转文字**: 语音消息自带 `text` 字段 (ASR 结果)

---

## 基于此协议可做的事情

### 1. 消息类应用

| 能力 | 描述 | 所需 API |
|------|------|----------|
| 收发文本 | 基础聊天 | `getupdates` + `sendmessage` |
| 收发图片 | CDN 加密传输 | + `getuploadurl` + CDN |
| 收发语音 | SILK 编码，自带 ASR | + SILK 转码 |
| 收发视频 | 缩略图 + 原视频 | + CDN |
| 收发文件 | 任意文件附件 | + CDN |
| 输入状态 | "正在输入..." 提示 | `sendtyping` |

### 2. AI 助手类

```
微信用户 ──消息──▶ 你的服务 ──调用──▶ AI 模型
    ▲                                      │
    └──────────── 回复 ◀───────────────────┘
```

**可实现**:
- 个人 ChatBot (Claude/GPT/本地模型)
- 知识库问答 (RAG)
- 多模态对话 (图片/语音理解)
- Agent 工具调用 (天气/搜索/执行命令)

### 3. 自动化/通知类

```
外部系统 ──事件──▶ 你的服务 ──推送──▶ 微信用户
   │                               │
   │◀──────── 命令/确认 ───────────┘
```

**可实现**:
- CI/CD 状态通知
- 监控报警推送
- 日程提醒
- 服务器控制面板
- 自动化工作流触发

### 4. 客服/群聊类

- 多账号管理
- 白名单控制 (`allowFrom`)
- 上下文隔离 (`per-channel-per-peer` 模式)
- 会话记录归档
- 智能分流

### 5. 媒体处理类

- 图片 OCR / 压缩
- 语音笔记转文字 (ASR 已内置)
- 文件格式转换
- 视频转码

---

## 裸调示例 (不依赖 OpenClaw 框架)

```javascript
const BASE = "https://ilinkai.weixin.qq.com";
const token = "扫码后获取的 bot_token";

// 通用请求头
function buildHeaders() {
  const uin = Buffer.from(String(Math.random() * 4294967295 | 0)).toString("base64");
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": uin,
    "Authorization": `Bearer ${token}`
  };
}

// 1. 收消息 (长轮询)
let getUpdatesBuf = "";
async function pollMessages() {
  const resp = await fetch(`${BASE}/ilink/bot/getupdates`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ get_updates_buf: getUpdatesBuf })
  });
  const { msgs, get_updates_buf: newBuf } = await resp.json();
  getUpdatesBuf = newBuf ?? getUpdatesBuf;
  return msgs ?? [];
}

// 2. 发消息 (必须带 context_token)
async function sendMessage(toUserId, text, contextToken) {
  await fetch(`${BASE}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      msg: {
        to_user_id: toUserId,
        message_type: 2,  // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }]
      }
    })
  });
}

// 3. 主循环
while (true) {
  const msgs = await pollMessages();
  for (const msg of msgs) {
    if (msg.message_type !== 1) continue; // 只处理用户消息
    const text = msg.item_list?.[0]?.text_item?.text;
    await sendMessage(msg.from_user_id, `回复: ${text}`, msg.context_token);
  }
}
```

**注意**: 登录流程（获取 token）仍需通过二维码扫码，可用官方 CLI:
```bash
npx -y @tencent-weixin/openclaw-weixin-cli install
openclaw channels login --channel openclaw-weixin
```
