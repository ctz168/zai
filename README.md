# Z.AI Zero-Token SDK

Use chat.z.ai without an API key — login via browser, call API forever. Now with **AICQ Agent Mode** for chatbot integration via aicq.online.

## How It Works

1. `zai login` opens a real browser to chat.z.ai
2. You login manually (Google, GitHub, email, etc.)
3. Browser cookies are captured and saved to `~/.zai/auth.json`
4. `zai chat` uses those cookies to call the chat.z.ai API directly
5. `zai agent` connects to aicq.online and acts as an AI chatbot
6. **No API key needed — zero token!**

## Quick Start

```bash
# Install
npm install

# Build
npm run build

# Login (opens browser to chat.z.ai)
node dist/cli.js login

# Chat!
node dist/cli.js chat "你好，你是谁？"

# Streaming chat
node dist/cli.js chat --stream "解释量子计算"

# Start HTTP API server
node dist/cli.js serve --port 3456

# Start AICQ Agent (connect to aicq.online)
node dist/cli.js agent --name "我的AI助手"
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `zai login` | Open browser, login to chat.z.ai |
| `zai login --cdp-url URL` | Connect to running Chrome |
| `zai status` | Check login status |
| `zai chat "message"` | Send a chat message |
| `zai chat --stream "msg"` | Stream response |
| `zai chat --model glm-4-plus "msg"` | Use specific model |
| `zai models` | List available models |
| `zai serve [--port 3456]` | Start HTTP server |
| `zai agent [--name "Bot"]` | Start AICQ Agent mode |
| `zai agent-config show` | Show agent configuration |
| `zai agent-config init` | Initialize agent config |
| `zai agent-config master add <id>` | Add agent master |
| `zai logout` | Clear saved auth |

## AICQ Agent Mode

`zai agent` starts an AI agent that connects to [aicq.online](https://aicq.online) via the AICQ protocol:

- **Streaming Chat** — Replies are sent chunk-by-chunk via AICQ `stream_chunk` protocol
- **Friend Management** — Add friends by code, auto-accept requests
- **Group Chat** — Responds to @mentions in group conversations
- **Master Control** — Designated masters can issue admin commands
- **Conversation Memory** — Per-peer/group history maintained automatically
- **E2EE Compatible** — NaCl (Ed25519 + X25519) crypto compatible with AICQ

### Agent Admin Commands (in chat, from masters)

```
/help          Show all admin commands
/status        View agent status
/model NAME    Switch LLM model
/prompt TEXT   Set system prompt
/master        Manage masters list
/clear         Clear conversation memory
/nickname      Change display name
```

## HTTP Server Endpoints

Start with `zai serve`, then:

### POST /chat

```bash
curl -X POST http://localhost:3456/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

### POST /chat/stream

```bash
curl -N http://localhost:3456/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "Tell me a story"}'
```

### GET /status

Check login status and cookie health.

### GET /models

List available model IDs and their assistant IDs.

### POST /logout

Clear saved authentication.

## TypeScript SDK

```typescript
import { loginViaBrowser, ZaiZeroTokenClient } from "zai";

// Login (first time only)
await loginViaBrowser();

// After login, cookies are persisted — just create a client
const client = new ZaiZeroTokenClient();

// Simple chat
const result = await client.chat("Hello, who are you?");
console.log(result.text);

// Streaming chat
await client.chatStream("Tell me a joke", {
  onText: (delta) => process.stdout.write(delta),
  onThinking: (delta) => console.log("[thinking]", delta),
  onDone: (fullText) => console.log("\nDone!"),
});

// Agent mode
import { startAgent } from "zai";
const agent = await startAgent({ nickname: "My Bot" });
```

## Technical Details

### Authentication Flow

1. **Browser Login**: Playwright opens Chrome, you login manually
2. **Cookie Capture**: `chatglm_refresh_token` and `chatglm_token` are captured
3. **Token Refresh**: Uses the refresh token to get new access tokens via `/chatglm/user-api/user/refresh`
4. **API Calls**: Calls `/chatglm/backend-api/assistant/stream` with the access token and signed headers

### Request Signing

Every API request requires these headers (extracted from chat.z.ai frontend JS):

- `X-Sign`: MD5 hash of `{timestamp}-{nonce}-{secret}`
- `X-Nonce`: Random UUID
- `X-Timestamp`: Modified timestamp
- `X-Device-Id`: Random device UUID
- `X-Exp-Groups`: Feature flag groups

### Stream Parsing

The API returns SSE events with GLM's custom format:
- Text content in `parts[].content[].text` (accumulated, not delta)
- Thinking content wrapped in `<think...</thinkgt;` tags

## Available Models

| Model ID | Assistant ID |
|----------|-------------|
| glm-4-plus | 65940acff94777010aa6b796 |
| glm-4 | 65940acff94777010aa6b796 |
| glm-4-think | 676411c38945bbc58a905d31 |
| glm-4-zero | 676411c38945bbc58a905d31 |

## License

MIT
