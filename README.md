# ZAI - Zero-Token SDK for chat.z.ai

A standalone SDK that uses web browser login sessions (NOT API keys) to call the Z.AI (chat.z.ai) API for free — zero token consumption.

## How It Works

1. **Login**: Opens a real browser window via Playwright, you login with your account/password
2. **Session Capture**: Captures cookies (chatglm_token, chatglm_refresh_token, etc.)
3. **Session Persistence**: Saves cookies to `~/.zai/session.json`
4. **API Calls**: Uses the saved cookies + X-Sign headers to call chat.z.ai backend API directly

No API key needed! Just your regular Z.AI account login.

## Installation

```bash
npm install
npx playwright install chromium
```

## CLI Usage

```bash
# Login via browser
node src/cli.js login

# Send a chat message
node src/cli.js chat "Hello, how are you?"

# Check login status
node src/cli.js status

# Test API connection
node src/cli.js test

# Start HTTP API server
node src/cli.js server 3210
```

## HTTP API Server

```bash
node src/cli.js server 3210
```

### Endpoints

- `GET /` - API info
- `GET /status` - Check login status
- `POST /login` - Start browser login
- `POST /logout` - Clear session
- `POST /chat` - Send chat message

### Chat API Example

```bash
# Non-streaming
curl -X POST http://localhost:3210/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "stream": false}'

# Streaming (SSE)
curl -X POST http://localhost:3210/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "stream": true}'
```

## SDK Usage

```javascript
import { ZaiClient, login } from "./src/index.js";

// Step 1: Login
const session = await login();

// Step 2: Use client
const client = new ZaiClient(session);
const result = await client.chat({
  message: "Hello!",
  model: "glm-4-plus",
  stream: true,
  onChunk: (chunk) => process.stdout.write(chunk.delta),
});
```

## Supported Models

- glm-4-plus
- glm-4
- glm-4-think
- glm-4-zero

## Architecture

Based on the [openclaw-zero-token](https://github.com/linuxhsj/openclaw-zero-token) project, which uses web browser session cookies to access AI model APIs without consuming API tokens.
