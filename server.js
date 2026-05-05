const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// This helper checks the model name you typed in Janitor and returns the correct NVIDIA "thinking" flag
function getThinkingParams(model) {
    const m = model.toLowerCase();
    if (m.includes('deepseek')) return { thinking: true };
    if (m.includes('kimi')) return { thinking: true };
    if (m.includes('glm')) return { enable_thinking: true, clear_thinking: false };
    if (m.includes('qwen')) return { enable_thinking: true };
    return null;
}

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { model, messages, temperature, stream } = req.body;
        
        const thinkingParams = getThinkingParams(model);

        const nimRequest = {
            ...req.body, // Pass everything Janitor sent (temp, tokens, etc.)
            model: model, // Use exactly what you typed in Janitor
            extra_body: thinkingParams ? { chat_template_kwargs: thinkingParams } : undefined,
            stream: true // We force stream to handle the thinking box injection
        };

        const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
            headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
            responseType: 'stream'
        });

        res.setHeader('Content-Type', 'text/event-stream');

        let buffer = '';
        let isThinking = false;
        let hasClosedThinkTag = false;

        response.data.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            lines.forEach(line => {
                if (!line.startsWith('data: ') || line.includes('[DONE]')) {
                    if (line.includes('[DONE]')) res.write('data: [DONE]\n\n');
                    return;
                }

                try {
                    const data = JSON.parse(line.slice(6));
                    const delta = data.choices?.[0]?.delta || {};
                    const reasoning = delta.reasoning_content || '';
                    const content = delta.content || '';

                    let outputContent = "";

                    // 1. If the model starts "thinking", open the <think> tag for Janitor
                    if (reasoning && !isThinking) {
                        isThinking = true;
                        outputContent += "<think>\n";
                    }

                    if (reasoning) outputContent += reasoning;

                    // 2. If the model starts the actual "content", close the <think> tag
                    if (content && isThinking && !hasClosedThinkTag) {
                        hasClosedThinkTag = true;
                        outputContent += "\n</think>\n\n";
                    }

                    if (content) outputContent += content;

                    // 3. Send the formatted text back to Janitor in the standard 'content' field
                    if (outputContent || delta.role) {
                        data.choices[0].delta = { 
                            ...(delta.role && { role: delta.role }), 
                            content: outputContent 
                        };
                        res.write(`data: ${JSON.stringify(data)}\n\n`);
                    }
                } catch (e) {}
            });
        });

        response.data.on('end', () => res.end());
    } catch (error) {
        console.error("NVIDIA Error:", error.response?.data || error.message);
        res.status(500).json({ error: { message: "Proxy error" } });
    }
});

app.listen(PORT, () => console.log(`Proxy running. Type your NVIDIA model ID directly into Janitor!`));
