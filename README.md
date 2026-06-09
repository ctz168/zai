# Z.AI API Wrapper

Standalone Z.AI API wrapper - login once, call forever via API.

Wraps the Z.AI global endpoint (`https://api.z.ai/api/paas/v4`) with an easy-to-use CLI, HTTP server, and TypeScript SDK.

## Features

- **Login once** - API key persisted locally, auto-reused
- **CLI** - Chat from the terminal
- **HTTP Server** - OpenAI-compatible API for integration
- **Streaming** - SSE streaming support
- **Multiple Models** - GLM-5, GLM-4.7, GLM-4.5 series
- **Tool Calling** - Agent loop with tool use
- **TypeScript SDK** - Programmatic access

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Login (saves API key to ~/.zai/config.json)
node dist/cli.js login --api-key YOUR_API_KEY

# Chat
node dist/cli.js chat "Hello, who are you?"

# Streaming chat
node dist/cli.js chat --stream "Explain quantum computing"

# Start API server
node dist/cli.js serve --port 3456
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `zai login [--api-key KEY]` | Save API key |
| `zai logout` | Remove saved API key |
| `zai status` | Check login status |
| `zai chat "message"` | Send a chat message |
| `zai chat --stream "msg"` | Stream response |
| `zai chat --model glm-5 "msg"` | Use specific model |
| `zai models` | List available models |
| `zai serve [--port 3456]` | Start HTTP server |
| `zai help` | Show help |

## HTTP Server Endpoints

Start the server with `zai serve`, then use these endpoints:

### POST /login

Save your API key.

```bash
curl -X POST http://localhost:3456/login \
  -H "Content-Type: application/json" \
  -d '{"api_key": "your_api_key_here"}'
```

### POST /chat

Simple chat, returns full response.

```bash
curl -X POST http://localhost:3456/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "model": "glm-4.7-flash"}'
```

### POST /chat/stream

Streaming chat (SSE).

```bash
curl -N http://localhost:3456/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "Tell me a story", "stream": true}'
```

### POST /completions

OpenAI-compatible chat completions.

```bash
curl -X POST http://localhost:3456/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.7-flash",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

Streaming:

```bash
curl -N http://localhost:3456/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.7-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### GET /models

List available models.

### GET /status

Check login status.

### POST /logout

Remove saved API key.

## TypeScript SDK

```typescript
import { ZaiClient } from "zai";

// After `zai login`, the client auto-loads the saved key
const client = new ZaiClient();

// Simple chat
const text = await client.chat("Hello, who are you?");

// Streaming chat
await client.chatStream("Tell me a joke", (chunk) => {
  process.stdout.write(chunk);
});

// Full completions API
const response = await client.chatCompletion({
  model: "glm-4.7-flash",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Explain AI in one sentence." },
  ],
  temperature: 0.7,
});

// Tool calling (agent loop)
const conversation = await client.agentLoop({
  messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  }],
  onToolCall: async (name, args) => {
    if (name === "get_weather") {
      return JSON.stringify({ city: "Tokyo", temp: "18C", condition: "sunny" });
    }
    return "unknown tool";
  },
});
```

## Available Models

| Model ID | Name | Context Window | Max Tokens |
|----------|------|---------------|------------|
| glm-5 | GLM-5 | 202,800 | 131,100 |
| glm-5-turbo | GLM-5 Turbo | 202,800 | 131,100 |
| glm-4.7 | GLM-4.7 | 204,800 | 131,072 |
| glm-4.7-flash | GLM-4.7 Flash | 200,000 | 131,072 |
| glm-4.7-flashx | GLM-4.7 FlashX | 200,000 | 128,000 |
| glm-4.5 | GLM-4.5 | 131,072 | 98,304 |
| glm-4.5-flash | GLM-4.5 Flash | 131,072 | 98,304 |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| ZAI_API_KEY | - | API key (alternative to `zai login`) |
| ZAI_BASE_URL | https://api.z.ai/api/paas/v4 | API base URL |
| ZAI_DEFAULT_MODEL | glm-4.7-flash | Default model |
| ZAI_PORT | 3456 | Server port |

## License

MIT
