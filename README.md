# OpenClaw WeCom (Enterprise WeChat) AI Bot Plugin

[简体中文](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README_ZH.md) | [English](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README.md)

`openclaw-plugin-wecom` is a WeCom (Enterprise WeChat) integration plugin developed for the [OpenClaw](https://github.com/openclaw/openclaw) framework. It enables seamless integration of powerful AI capabilities into WeCom with advanced features.

## ✨ Key Features

- 🌊 **Streaming Output**: Smooth typewriter-style responses using WeCom's latest AI bot streaming mechanism.
- 🤖 **Dynamic Agent Management**: Automatically creates independent Agents per user/group chat with isolated workspaces and conversation contexts.
- 👥 **Group Chat Integration**: Full support for group messages with @mention triggering.
- 📷 **Multimedia Input Support**: Process images, voice messages, and mixed content (image+text) with automatic decryption.
- 🛠️ **Command Support**: Built-in commands (`/new`, `/status`, `/help`, `/compact`) with configurable whitelist.
- 🔒 **Security**: Complete support for WeCom message encryption/decryption and sender verification.
- ⚡ **Async Processing**: High-performance async architecture ensures gateway responsiveness during AI inference.

## 📷 Multimedia Message Support

The plugin supports various message types from WeCom:

| Message Type       | Input Support | Image Decrypt  | AI Processing    |
| ------------------ | ------------- | -------------- | ---------------- |
| Text               | ✅            | -              | ✅ Full support  |
| Image              | ✅            | ✅ AES-256-CBC | ✅ Base64 for AI |
| Voice              | ✅            | -              | 📝 Prompt only   |
| Mixed (Image+Text) | ✅            | ✅             | ✅ Multimodal    |
| File               | ✅            | -              | 📝 Prompt only   |
| Video              | ✅            | -              | 📝 Prompt only   |

### Image Processing

WeCom AI Bot encrypts images using AES-256-CBC. The plugin automatically:

1. Downloads encrypted image from WeCom
2. Decrypts using your `encodingAesKey`
3. Converts to Base64 for AI multimodal processing
4. Cleans up temporary files periodically

### Voice Messages

Voice messages are downloaded and stored temporarily. By default, a friendly prompt is returned since voice transcription requires external services.

To enable voice transcription, integrate with external ASR services in `voice-api.js`.

## 🚀 Quick Start

### Option 1: Docker Deployment (Recommended)

This repository provides a complete Docker deployment solution that **deploys OpenClaw + WeCom plugin in one step**, with automated installation and configuration.

```bash
# 1. Clone the repository
git clone https://github.com/sunnoy/openclaw-plugin-wecom.git
cd openclaw-plugin-wecom/deploy

# 2. Copy environment configuration
cp .env.example .env

# 3. Edit .env file with your settings
vim .env

# 4. Run deployment script
./deploy.sh
```

The deployment script automatically:

- Creates data directories and sets permissions
- Generates configuration files
- Starts Docker containers
- Installs the WeCom plugin
- Configures and restarts services

#### 🌟 Deployment Highlights

**Custom Data Directory & Agent Workspace Paths**

The core advantage of this deployment is unified data storage in a custom path, effectively utilizing data disks:

```bash
# .env configuration example
OPENCLAW_DATA_DIR=/data/openclaw    # Custom data directory
```

- **OpenClaw State Directory**: `/data/openclaw/`
- **Dynamic Agent Workspace**: `/data/openclaw/.openclaw/`
- **Plugin Directory**: `/data/openclaw/extensions/`
- **Canvas Data**: `/data/openclaw/canvas/`

Benefits:

- ✅ All Agent workspace data stored on data disk, avoiding system disk usage
- ✅ Independent Agent files for each user/group managed under unified path
- ✅ Easy backup, migration, and expansion
- ✅ Enterprise-ready deployment with independently mountable data disks

### Option 2: Manual Plugin Installation

Install in an existing OpenClaw environment:

```bash
openclaw plugins install openclaw-plugin-wecom
```

Or via npm:

```bash
npm install openclaw-plugin-wecom
```

Then add to your OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "wecom": { "enabled": true }
    }
  },
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "Your Token",
      "encodingAesKey": "Your EncodingAESKey"
    }
  }
}
```

### WeCom Backend Setup

1. Create an "Intelligent Bot" in WeCom Admin Console.
2. Set the "Receive Message" URL to your service address (e.g., `https://your-domain.com/webhooks/wecom`).
3. Enter the corresponding Token and EncodingAESKey.

## 📂 Project Structure

```
openclaw-plugin-wecom/
├── deploy/                      # Deployment files
│   ├── deploy.sh               # One-click deployment script
│   ├── docker-compose.yml      # Docker Compose configuration
│   ├── .env.example            # Environment variables template
│   ├── openclaw.json.base      # Base configuration template
│   └── openclaw.json.template  # Full configuration template
├── Dockerfile                   # OpenClaw image build file
├── index.js                     # Plugin entry point
├── webhook.js                   # WeCom HTTP communication & message parsing
├── message-handler.js           # Unified multimedia message processor
├── dynamic-agent.js             # Dynamic Agent routing
├── stream-manager.js            # Streaming response management
├── crypto.js                    # WeCom message encryption/decryption
├── client.js                    # Response URL client
├── contact-api.js               # Address book API (user/department info)
├── app-message.js               # Proactive message push API
├── media-api.js                 # Media upload/download management
├── voice-api.js                 # Voice message processing
├── image-decrypt.js             # WeCom image decryption
├── utils.js                     # Utility functions
└── logger.js                    # Logging module
```

## 🔧 WeCom API Configuration

In addition to the basic bot callback settings, the following advanced features require WeCom API credentials:

| Feature                             | Required Config                 |
| ----------------------------------- | ------------------------------- |
| Get user details (name, department) | `corpId` + `secret`             |
| Push messages proactively           | `corpId` + `secret` + `agentId` |
| Upload/download media files         | `corpId` + `secret`             |
| Download voice messages             | `corpId` + `secret`             |
| Address book search                 | `corpId` + `secret`             |

### How to Obtain Credentials

| Config    | Location                                                    |
| --------- | ----------------------------------------------------------- |
| `corpId`  | WeCom Admin Console → My Enterprise → Enterprise ID         |
| `secret`  | WeCom Admin Console → App Management → Custom App → Secret  |
| `agentId` | WeCom Admin Console → App Management → Custom App → AgentId |

### Environment Variables

Add to your `.env` file:

```bash
# WeCom API Configuration (Optional)
WECOM_CORP_ID=ww1234567890abcdef     # Enterprise ID
WECOM_SECRET=your-app-secret-here    # App Secret
WECOM_AGENT_ID=1000001               # App AgentId
```

### Configuration Example

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "your-token",
      "encodingAesKey": "your-aes-key",
      "webhookPath": "/wecom",
      "corpId": "ww1234567890abcdef",
      "secret": "your-app-secret",
      "agentId": "1000001"
    }
  }
}
```

> ⚠️ **Permissions**: Address book API requires "Contacts" read permission configured for the app in WeCom Admin Console.

## 🤖 Dynamic Agent Routing

The plugin implements per-user/per-group isolation:

1. On message arrival, generates a deterministic `agentId`:
   - DM: `wecom-dm-<userId>`
   - Group: `wecom-group-<chatId>`
2. OpenClaw automatically creates/reuses the corresponding Agent workspace.

### Configuration Options

Under `channels.wecom`:

| Option                         | Type    | Default | Description                |
| ------------------------------ | ------- | ------- | -------------------------- |
| `dynamicAgents.enabled`        | boolean | `true`  | Enable dynamic Agents      |
| `dm.createAgentOnFirstMessage` | boolean | `true`  | Use dynamic Agent for DMs  |
| `groupChat.enabled`            | boolean | `true`  | Enable group chat handling |
| `groupChat.requireMention`     | boolean | `true`  | Require @mention in groups |

To route all messages to the default Agent:

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": { "enabled": false }
    }
  }
}
```

## 🛠️ Command Whitelist

To prevent regular users from executing sensitive Gateway management commands via WeCom messages, this plugin supports a **command whitelist** mechanism. Only commands in the whitelist will be executed; others are ignored.

> 💡 **Note**: This configuration is already included in `deploy/openclaw.json.template` and takes effect automatically upon deployment.

```json
{
  "channels": {
    "wecom": {
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

| Command    | Description                     | Security Level |
| ---------- | ------------------------------- | -------------- |
| `/new`     | Reset conversation, start fresh | ✅ User-level  |
| `/compact` | Compress conversation context   | ✅ User-level  |
| `/help`    | Show help information           | ✅ User-level  |
| `/status`  | Show Agent status               | ✅ User-level  |

> ⚠️ **Security Note**: Do not add `/gateway`, `/plugins`, or other management commands to the whitelist to prevent regular users from gaining Gateway instance admin privileges.

## 🤝 Contributing

We welcome contributions! Please submit Issues or Pull Requests for bugs or feature suggestions.

## 📄 License

This project is licensed under the [ISC License](./LICENSE).
