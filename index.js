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

app.post('/chat', async(req, res) => {
  try {
    const chatThread = await ChatThread.create({ title: req.body.title });
    res.json({ chatThread });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

app.put('/chat/:chatThreadId', async(req, res) => {
  try {
    const { chatThreadId } = req.params;
    const { content } = req.body;
    const chatThread = await ChatThread.findOne({ _id: chatThreadId }).orFail();

    const messages = await ChatMessage.find({ chatThreadId }).sort({ createdAt: 1 });
    const llmMessages = messages.map(m => ({
      role: m.role,
      content: m.content
    }));
    llmMessages.push({ role: 'user', content });

    const chatMessages = await Promise.all([
      ChatMessage.create({
        chatThreadId,
        content,
        role: 'user'
      }),
      getChatCompletion([systemPrompt, ...trimMessagesToFit(llmMessages)]).then(response => ChatMessage.create({
        chatThreadId,
        content: response.data.choices[0].message.content,
        role: 'assistant'
      }))
    ]);

    if (!chatThread.title) {
      const systemPrompt = {
        role: 'system',
        content: 'Summarize the following conversation in a short sentence 3-8 words.'
      };
      const response = await getChatCompletion(
        [systemPrompt, ...trimMessagesToFit(llmMessages, 'gpt-4.1-nano', 5000)],
        'gpt-4.1-nano'
      );
      chatThread.title = response.data.choices[0].message.content;
      await chatThread.save();
    }

    res.json({ chatThread, chatMessages });
  } catch (err) {
    return res.status(500).json({ message: err.message });
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

app.listen(3000);
console.log('Listening on port 3000');
