'use strict';

const axios = require('axios');
const express = require('express');
const mongoose = require('mongoose');
const tiktoken = require('tiktoken');

const app = express();

const chatThreadSchema = new mongoose.Schema({
  title: {
    type: String
  },
  userId: {
    type: mongoose.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

const chatMessageSchema = new mongoose.Schema({
  chatThreadId: {
    type: 'ObjectId',
    required: true
  },
  role: {
    type: String,
    enum: ['user', 'assistant', 'system'],
    required: true
  },
  content: {
    type: String,
    required: true
  }
}, { timestamps: true });

mongoose.connect('mongodb://127.0.0.1:27017/mongoose_test');
const ChatThread = mongoose.model('ChatThread', chatThreadSchema);
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

const systemPrompt = {
  role: 'system',
  content: 'You are a developer who writes JavaScript in pirate voice'
};

app.use(express.json());

app.get('/chat', async (req, res) => {
  try {
    const chatThreads = await ChatThread.find().sort({ updatedAt: -1 });
    res.json({ chatThreads });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/chat/:chatThreadId', async (req, res) => {
  try {
    const { chatThreadId } = req.params;
    const chatThread = await ChatThread.findOne({ _id: chatThreadId });
    const chatMessages = await ChatMessage.find({ chatThreadId }).sort({ createdAt: 1 });
    res.json({ chatThread, chatMessages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/chat', async(req, res) => {
  try {
    const chatThread = await ChatThread.create({
      title: req.body.title
    });
    res.json({ chatThread });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Stream tokens from OpenAI for chat completion
app.put('/chat/:chatThreadId', async(req, res) => {
  try {
    const { chatThreadId } = req.params;
    const { content: userContent } = req.body;
    const chatThread = await ChatThread.findOne({ _id: chatThreadId }).orFail();

    const messages = await ChatMessage.find({ chatThreadId }).sort({ createdAt: 1 });
    const llmMessages = messages.map(m => ({
      role: m.role,
      content: m.content
    }));
    llmMessages.push({ role: 'user', content: userContent });

    // Save user message immediately
    const userMessage = await ChatMessage.create({
      chatThreadId,
      content: userContent,
      role: 'user'
    });

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Helper to send SSE data
    function sendSSE(data) {
      return res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // Stream assistant response from OpenAI
    let content = '';
    let assistantMessageDoc = null;

    // Start OpenAI streaming request
    const response = await axios({
      method: 'post',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream',
      data: {
        model: 'gpt-4o',
        messages: [systemPrompt, ...trimMessagesToFit(llmMessages)],
        stream: true
      }
    });

    response.data.on('data', async (chunk) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.replace(/^data:\s*/, '');
          if (data === '[DONE]') {
            // Save assistant message to DB
            assistantMessageDoc = new ChatMessage({ chatThreadId, content, role: 'assistant' });
            await assistantMessageDoc.save();
            // Summarize if necessary
            await summarizeThread(chatThread, llmMessages);
            // Send final SSE event and close
            sendSSE({ done: true, chatThread, userMessage, assistantMessage: assistantMessageDoc });
            res.end();
            return;
          } else {
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                content += delta;
                sendSSE({ token: delta });
              }
            } catch (e) {
              // Avoid JSON parsing errors from partial responses
            }
          }
        }
      }
    });

    response.data.on('end', () => {
      // If for some reason [DONE] wasn't sent, end the response
      if (!res.writableEnded && !assistantMessageDoc) {
        res.end();
      }
    });

    response.data.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ message: err.message });
      } else {
        res.end();
      }
    });

  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ message: err.message });
    } else {
      res.end();
    }
  }
});

async function getChatCompletion(messages, model = 'gpt-4o') {
  return axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model, messages },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
}


function trimMessagesToFit(messages, model = 'gpt-4o', maxTokens = 120000) {
  const enc = tiktoken.encoding_for_model(model);
  let total = 0;
  const trimmed = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokenCount = enc.encode(messages[i].content).length + 4;
    if (total + tokenCount > maxTokens) break;
    trimmed.unshift(messages[i]);
    total += tokenCount;
  }

  return trimmed;
}

async function summarizeThread(chatThread, llmMessages) {
  if (!chatThread.title) {
    const systemPromptTitle = {
      role: 'system',
      content: 'Summarize the following conversation in a short sentence 3-8 words.'
    };
    const titleResponse = await getChatCompletion(
      [systemPromptTitle, ...trimMessagesToFit(llmMessages, 'gpt-4.1-nano', 5000)],
      'gpt-4.1-nano'
    );
    chatThread.title = titleResponse.data.choices[0].message.content;
    await chatThread.save();
  }
}

app.use(express.static('./public'));
app.listen(3000);
console.log('Listening on port 3000');
