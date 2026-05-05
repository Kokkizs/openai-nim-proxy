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
