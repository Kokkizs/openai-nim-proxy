const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-transform');
  next();
});

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = false;

const THINKING_CONFIG = {
  'deepseek-ai/deepseek-r1':           { thinking: true },
  'deepseek-ai/deepseek-r1-0528':      { thinking: true },
  'deepseek-ai/deepseek-v4-flash':     { enable_thinking: true, thinking: true },
  'deepseek-ai/deepseek-v4-pro':       { enable_thinking: true, thinking: true },
  'moonshotai/kimi-k2-instruct':       { thinking: true },
  'moonshotai/kimi-k2.5':              { thinking: true },
  'moonshotai/kimi-k2.6':              { thinking: true },
  'qwen/qwen3.5-397b-a17b':            { thinking: true },
  'qwen/qwen3-235b-a22b-instruct-2507':{ thinking: true },
  'qwen/qwen3.6-35b-a3b':              { enable_thinking: true },
  'z-ai/glm4.7':                       { enable_thinking: true, clear_thinking: false },
};

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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(model => ({
      id: model, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
    }))
  });
});

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

    const thinkingParams = (ENABLE_THINKING_MODE && THINKING_CONFIG[nimModel])
      ? THINKING_CONFIG[nimModel]
      : null;

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: thinkingParams ? { chat_template_kwargs: thinkingParams } : undefined,
      stream: true
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    const wantsStream = stream || false;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let buffer = '';
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let lastChunkData = null;

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      lines.forEach(line => {
        if (!line.startsWith('data: ')) return;
        if (line.includes('[DONE]')) {
          if (wantsStream) res.write('data: [DONE]\n\n');
          return;
        }

        try {
          const data = JSON.parse(line.slice(6));
          lastChunkData = data;
          const delta = data.choices?.[0]?.delta || {};
          const reasoning = delta.reasoning_content || '';
          const content = delta.content || '';

          // DEBUG - check Leapcell logs to see what fields are arriving
          if (reasoning) console.log('[DEBUG] reasoning_content:', reasoning.slice(0, 80));
          if (content)   console.log('[DEBUG] content:', content.slice(0, 80));
          if (!reasoning && !content) console.log('[DEBUG] other delta keys:', Object.keys(delta).join(', '));

          accumulatedReasoning += reasoning;
          accumulatedContent += content;

          if (wantsStream) {
            if (SHOW_REASONING && reasoning) {
              data.choices[0].delta.reasoning_content = reasoning;
            } else {
              delete data.choices[0].delta.reasoning_content;
            }
            data.choices[0].delta.content = content;
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        } catch (e) {
          if (wantsStream) res.write(line + '\n');
        }
      });
    });

    response.data.on('end', () => {
      if (wantsStream) {
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const msg = { role: 'assistant', content: accumulatedContent };
        if (SHOW_REASONING && accumulatedReasoning) msg.reasoning_content = accumulatedReasoning;
        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: msg, finish_reason: lastChunkData?.choices?.[0]?.finish_reason || 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }
    });

    response.data.on('error', (err) => {
      console.error('Stream error:', err);
      res.end();
    });

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
});
