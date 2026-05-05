app.post('/v1/chat/completions', async (req, res) => {
    try {
        const rawModel = req.body.model || '';
        const actualModel = rawModel.replace('-thinking', '');
        const modelLower = actualModel.toLowerCase();

        const cleanPayload = {
            model: actualModel,
            messages: req.body.messages.map(m => ({
                role: m.role === 'developer' ? 'system' : m.role,
                content: m.content
            })),
            temperature: req.body.temperature ?? 1,
            top_p: req.body.top_p ?? 1,
            max_tokens: req.body.max_tokens || 4096,
            stream: true // Confirmed enabled
        };

        if (modelLower.includes('glm')) {
            cleanPayload.chat_template_kwargs = { 
                enable_thinking: true, 
                clear_thinking: false 
            };
        } else if (modelLower.includes('deepseek-v4') || (modelLower.includes('kimi-k2') && !modelLower.includes('thinking'))) {
            cleanPayload.chat_template_kwargs = { thinking: true };
        }

        const response = await axios.post(`${NIM_API_BASE}/chat/completions`, cleanPayload, {
            headers: {
                'Authorization': `Bearer ${NIM_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        // --- CRITICAL STREAMING HEADERS ---
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Tells Nginx/Leapcell: "DO NOT BUFFER"
        res.setHeader('Transfer-Encoding', 'chunked');

        // Pipe the data directly
        response.data.pipe(res);

        // Optional: Error handling for the stream pipe
        response.data.on('error', (err) => {
            console.error("Stream Error:", err);
            res.end();
        });

    } catch (error) {
        // ... (keep your existing error handling)
    }
});
