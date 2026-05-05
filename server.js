# Complete OpenAI to NVIDIA NIM Proxy Deployment Guide
> ✅ Updated May 2026 — Now using **Leapcell** for hosting (zero credit card, ever). Model list refreshed.

## What This Does
Creates a free API proxy that translates OpenAI-style requests to NVIDIA NIM API, allowing you to use NVIDIA's AI models in apps like Janitor AI.

**Features:**
- ✅ OpenAI-compatible API format
- ✅ Automatic model mapping and smart fallback
- ✅ Optional thinking/reasoning display for advanced models
- ✅ Support for streaming and non-streaming responses
- ✅ Free to deploy and use (no credit card required)

---

## Step 1: Get Your NVIDIA API Key

### 1.1 Create NVIDIA Developer Account
1. Go to **https://build.nvidia.com/**
2. Click **"Sign In"** → **"Create Account"**
3. Fill out the registration form and verify your email

### 1.2 Get API Key
1. After logging in, visit **https://build.nvidia.com/explore/discover**
2. Click on any model (e.g., "Llama 3.1")
3. Click **"Get API Key"** button
4. Your key will start with `nvapi-` — **copy and save it somewhere safe**

> ⚠️ No credit card required. The free tier is truly free with rate limits (~40 req/min).

---

## Step 2: Set Up GitHub Repository

### 2.1 Create GitHub Account
1. Go to **https://github.com/**
2. Click **"Sign up"** and follow the steps

### 2.2 Create New Repository
1. Click the green **"New"** button
2. Repository name: `openai-nim-proxy`
3. Select **"Public"**
4. Check **"Add a README file"**
5. Click **"Create repository"**

---

## Step 3: Add Your Code Files

### 3.1 Create server.js
1. Click **"Add file"** → **"Create new file"**
2. Name: `server.js`
3. Paste the following:

```javascript
// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Disable compression so responses stay under Leapcell's 5MB compressed limit
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-transform');
  next();
});

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE
// true  = pass reasoning_content as its own field so Janitor AI shows it in the gray thinking bubble
// false = strip reasoning, only show final reply
const SHOW_REASONING = true;

// 🔥 THINKING MODE TOGGLE
const ENABLE_THINKING_MODE = false; // Master switch — set true to enable thinking for supported models

// Per-model thinking config sourced from NVIDIA NIM docs.
// Different model families use different parameter names — sending the wrong one causes a 400.
// 'thinking'        → Kimi K2.x, Qwen3.5, DeepSeek R1
// 'enable_thinking' → Qwen3.6, Qwen3.5 VLM variants, GLM4.x
// DeepSeek V4 requires BOTH flags together or it hangs indefinitely.
const THINKING_CONFIG = {
  'deepseek-ai/deepseek-r1':                    { thinking: true },
  'deepseek-ai/deepseek-r1-0528':               { thinking: true },
  'deepseek-ai/deepseek-v4-flash':              { enable_thinking: true, thinking: true }, // requires both
  'deepseek-ai/deepseek-v4-pro':                { enable_thinking: true, thinking: true }, // requires both
  'moonshotai/kimi-k2-instruct':                { thinking: true },
  'moonshotai/kimi-k2.5':                       { thinking: true },
  'moonshotai/kimi-k2.6':                       { thinking: true },
  'qwen/qwen3.5-397b-a17b':                     { thinking: true },
  'qwen/qwen3-235b-a22b-instruct-2507':         { thinking: true },
  'qwen/qwen3.6-35b-a3b':                       { enable_thinking: true },
  'z-ai/glm4.7':                                { enable_thinking: true, clear_thinking: false }, // clear_thinking:false preserves reasoning across turns
};

// Model mapping — updated May 2026
const MODEL_MAPPING = {
  'gpt-3.5-turbo':  'meta/llama-3.3-70b-instruct',
  'gpt-4':          'deepseek-ai/deepseek-v3-0324',
  'gpt-4-turbo':    'moonshotai/kimi-k2-instruct',
  'gpt-4o':         'deepseek-ai/deepseek-r1',
  'claude-3-opus':  'openai/gpt-oss-120b',
  'claude-3-sonnet':'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gemini-pro':     'qwen/qwen3-235b-a22b-instruct-2507',
  'claude-3-haiku': 'minimax/minimax-m2',
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(model => ({
      id: model,
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy'
    }))
  });
});

// Main proxy endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      const lower = model.toLowerCase();
      if (lower.includes('gpt-4') || lower.includes('405b')) nimModel = 'deepseek-ai/deepseek-r1';
      else if (lower.includes('claude') || lower.includes('70b')) nimModel = 'meta/llama-3.3-70b-instruct';
      else nimModel = 'meta/llama-3.1-8b-instruct';
    }

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: (ENABLE_THINKING_MODE && THINKING_CONFIG[nimModel])
        ? { chat_template_kwargs: THINKING_CONFIG[nimModel] }
        : undefined,
      stream: stream || false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          if (line.includes('[DONE]')) { res.write(line + '\n'); return; }

          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta) {
              const reasoning = data.choices[0].delta.reasoning_content;
              const content = data.choices[0].delta.content;

              if (SHOW_REASONING) {
                let combined = '';
                if (reasoning && !reasoningStarted) { combined = '<think>\n' + reasoning; reasoningStarted = true; }
                else if (reasoning) { combined = reasoning; }
                if (content && reasoningStarted) { combined += '</think>\n\n' + content; reasoningStarted = false; }
                else if (content) { combined += content; }
                if (combined) data.choices[0].delta.content = combined;
              } else {
                data.choices[0].delta.content = content || '';
              }
              delete data.choices[0].delta.reasoning_content;
            }
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) { res.write(line + '\n'); }
        });
      });

      response.data.on('end', () => res.end());
      response.data.on('error', (err) => { console.error('Stream error:', err); res.end(); });

    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            content = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + content;
          }
          return { index: choice.index, message: { role: choice.message.role, content }, finish_reason: choice.finish_reason };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: { message: error.message || 'Internal server error', type: 'invalid_request_error', code: error.response?.status || 500 }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 } });
});

app.listen(PORT, () => {
  console.log(`OpenAI → NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Reasoning: ${SHOW_REASONING} | Thinking mode: ${ENABLE_THINKING_MODE}`);
});
```

4. Click **"Commit new file"**

### 3.2 Create package.json
1. Click **"Add file"** → **"Create new file"**
2. Name: `package.json`
3. Paste:

```json
{
  "name": "openai-nim-proxy",
  "version": "1.0.0",
  "description": "OpenAI compatible proxy for NVIDIA NIM API",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "axios": "^1.6.0"
  },
  "engines": {
    "node": "18.x"
  }
}
```

4. Click **"Commit new file"**

---

## Step 4: Deploy to Leapcell (Free — Zero Credit Card, Ever)

> ℹ️ **Why Leapcell?**
> - **Railway**: One-time $5 trial then paid
> - **Render**: Asks for a credit card, users report unexpected charges
> - **Koyeb**: Also asks for card verification
> - **Leapcell** ✅: Deploy up to **20 projects completely free**, no credit card at any point, no idle/sleep charges, commercial use allowed

### 4.1 Sign Up for Leapcell
1. Go to **https://leapcell.io/**
2. Click **"Get Started With GitHub"**
3. Authorize Leapcell to access your GitHub
4. That's it — no credit card, no form to fill out

### 4.2 Create New Service
1. From the Leapcell dashboard, click **"+ New Service"**
2. Select **"GitHub"** as your source
3. Choose your `openai-nim-proxy` repository and the `main` branch
4. Configure:
   - **Service name**: `openai-nim-proxy`
   - **Runtime**: Node.js (auto-detected)
   - **Build command**: `npm install`
   - **Run command**: `npm start`
   - **Port**: `3000`
5. Click **"Deploy"**

### 4.3 Add Environment Variable
1. Go to **"Environment Variables"** in your service settings
2. Click **"Add Variable"**
3. Key: `NIM_API_KEY`
4. Value: Paste your `nvapi-...` key from Step 1
5. Save — Leapcell will redeploy automatically

### 4.4 Wait for Deployment
1. Watch the **"Deployments"** tab
2. Wait for status to show **"Running"** (2–4 minutes)

---

## Step 5: Get Your API URL

### 5.1 Find Your URL
1. In Leapcell, your URL is shown at the top of the service page
2. It looks like: `https://xxxxxxx.leapcell.dev`

### 5.2 Test It
Open your browser and go to:
```
https://xxxxxxx.leapcell.dev/health
```

You should see:
```json
{
  "status": "ok",
  "service": "OpenAI to NVIDIA NIM Proxy",
  "reasoning_display": false,
  "thinking_mode": false
}
```

> ✅ **No sleep mode, no idle charges** — Leapcell does not shut down your app when it's not in use. No UptimeRobot tricks needed.

---

## Step 6: Configure Janitor AI

1. Open Janitor AI → **Settings** → **API Configuration**
2. Enter:
   - **API Type**: OpenAI / Custom OpenAI
   - **Base URL**: `https://xxxxxxx.leapcell.dev`
   - **API Key**: Enter anything (e.g., `dummy-key`)
   - **Model**: Choose from the list below
3. Start a conversation to test 🎉

---

## Available Models (Updated May 2026)

| Janitor AI Model | Maps to NVIDIA NIM Model |
|------------------|--------------------------|
| gpt-3.5-turbo | Llama 3.3 70B Instruct |
| gpt-4 | DeepSeek V3 (Mar 2024) |
| gpt-4-turbo | Kimi K2 Instruct |
| gpt-4o | DeepSeek R1 (reasoning) |
| claude-3-opus | GPT-OSS 120B |
| claude-3-sonnet | Llama Nemotron Ultra 253B |
| gemini-pro | Qwen3 235B |
| claude-3-haiku | MiniMax M2 |

> 💡 All models are free on NVIDIA NIM's preview tier. Larger models may have slower responses during peak hours.

---

## Configuration Options

### Reasoning Display (line ~17 in server.js)
```javascript
const SHOW_REASONING = false; // true = shows <think>...</think> reasoning block
```

### Thinking Mode (line ~20)
```javascript
const ENABLE_THINKING_MODE = false; // true = passes chat_template_kwargs: { thinking: true }
```
Only needed for specific reasoning models like DeepSeek R1 or Qwen3. Most models work without it.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| 500 error | Check `NIM_API_KEY` is set in Leapcell → Environment Variables |
| 429 error | NVIDIA rate limit hit — wait a moment and retry |
| "Endpoint not found" on root URL | Normal! Test `/health` not `/` |
| Model not responding | Try a different model from the table above |
| Can't find my URL | It's shown on your Leapcell service page under "Domains" |

---

## Your Quick Reference

| What | URL |
|---|---|
| Health check | `https://xxxxxxx.leapcell.dev/health` |
| Models list | `https://xxxxxxx.leapcell.dev/v1/models` |
| Chat endpoint | `https://xxxxxxx.leapcell.dev/v1/chat/completions` |

**For Janitor AI:** Use your Leapcell domain as Base URL, any string as API Key, pick a model from the table. 🚀
