# 微信 ClawBot

基于微信官方 **iLink Bot API** 的机器人框架。

## 快速开始

### 1. 安装依赖 (可选)

```bash
npm install
```

> 用于终端显示二维码，不安装也能用 (会打开浏览器显示)

### 2. 登录获取 Token

```bash
npm run login
# 或
node scripts/login.js
```

用微信扫描二维码，登录成功后凭证会保存到 `.weixin-credentials.json`

### 3. 测试连接

```bash
npm run test
# 或
node scripts/test-connection.js
```

### 4. 发送消息

```bash
# 直接发送 (需要 userId)
node scripts/send-message.js "xxx@im.wechat" "你好"

# 等待对方消息后自动回复
node scripts/send-message.js -w "收到，稍后回复你"

# 查看已知用户
node scripts/send-message.js -l
```

---

## 脚本说明

| 脚本 | 说明 |
|------|------|
| `scripts/login.js` | 二维码登录，获取 bot_token |
| `scripts/test-connection.js` | 测试连接 + 消息监听模式 |
| `scripts/send-message.js` | 主动发送消息 |

---

## 核心 API

### 请求头

```http
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <base64随机UIN>
Authorization: Bearer <bot_token>
```

### 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/ilink/bot/get_bot_qrcode` | GET | 获取登录二维码 |
| `/ilink/bot/get_qrcode_status` | GET | 轮询扫码状态 |
| `/ilink/bot/getupdates` | POST | 长轮询收消息 |
| `/ilink/bot/sendmessage` | POST | 发送消息 |
| `/ilink/bot/getuploadurl` | POST | 获取 CDN 上传地址 |
| `/ilink/bot/getconfig` | POST | 获取配置 |
| `/ilink/bot/sendtyping` | POST | 发送"正在输入"状态 |

### 消息类型

| type | 类型 |
|------|------|
| 1 | 文本 |
| 2 | 图片 |
| 3 | 语音 (SILK) |
| 4 | 文件 |
| 5 | 视频 |

---

## 关键概念

### context_token

每条收到的消息都带有 `context_token`，**回复时必须原样带上**，否则消息不会关联到正确对话。

```javascript
// 收到消息
const { from_user_id, context_token } = receivedMsg;

// 回复时必须带上
await sendMessage(from_user_id, "回复内容", context_token);
```

### get_updates_buf

长轮询游标，类似数据库 cursor。必须每次更新，否则会重复收到消息。

```javascript
let buf = "";
while (true) {
  const { msgs, get_updates_buf } = await getUpdates(buf);
  buf = get_updates_buf;  // 更新游标
  // 处理 msgs...
}
```

### CDN 媒体加密

图片/语音/视频/文件 通过 CDN 传输，使用 **AES-128-ECB** 加密：

```
1. 生成随机 AES-128 key
2. AES-128-ECB 加密文件
3. 调用 getuploadurl 获取预签名 URL
4. POST 加密文件到 CDN
5. 使用返回的 download_param 发送消息
```

---

## 示例代码

### 收发消息

```javascript
const BASE = "https://ilinkai.weixin.qq.com";
const token = "your_bot_token";

// 收消息
const resp = await fetch(`${BASE}/ilink/bot/getupdates`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Authorization": `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(Math.random() * 4294967295 | 0)).toString("base64"),
  },
  body: JSON.stringify({ get_updates_buf: "" }),
});
const { msgs, get_updates_buf } = await resp.json();

// 发消息
for (const msg of msgs || []) {
  if (msg.message_type === 1) {  // 用户消息
    await fetch(`${BASE}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: { /* 同上 */ },
      body: JSON.stringify({
        msg: {
          to_user_id: msg.from_user_id,
          message_type: 2,
          message_state: 2,
          context_token: msg.context_token,  // 必须!
          item_list: [{ type: 1, text_item: { text: "收到" } }],
        },
      }),
    });
  }
}
```

---

## 可构建的应用

| 场景 | 描述 |
|------|------|
| **AI 助手** | 接入 Claude/GPT，微信对话 |
| **通知机器人** | CI/CD 状态、监控报警推送 |
| **自动化** | 接收指令触发工作流 |
| **客服系统** | 多账号、智能分流 |

---

## 文件结构

```
weixin_clawbot/
├── package.json
├── README.md                   # 本文档
├── .gitignore
├── .weixin-credentials.json    # 登录凭证 (gitignore)
├── docs/
│   └── openclaw-weixin-protocol.md  # 完整协议文档
├── scripts/
│   ├── login.js                # 登录
│   ├── test-connection.js      # 测试
│   └── send-message.js         # 发消息
└── openclaw-weixin-1.0.3/      # 官方源码
```

---

## 注意事项

1. **Token 有效期**: 长期有效，但遇到 `errcode: -14` 需重新登录
2. **context_token**: 必须带上才能正确关联对话
3. **首次发消息**: 对方需要先给你发过消息 (获取 context_token)
4. **媒体文件**: 需要 AES-128-ECB 加密后上传 CDN
5. **官方条款**: 腾讯只是"管道"，可随时终止服务

---

## 相关资源

- [iLink Bot API 协议文档](./docs/openclaw-weixin-protocol.md)
- [官方源码分析](./openclaw-weixin-1.0.3/package/src/)
- [npm: @tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)

---

## License

MIT
