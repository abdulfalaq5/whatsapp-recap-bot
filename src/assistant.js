import * as storage from './storage.js';
import * as ollama from './ollama.js';
import { formatChatHistory } from './commands.js';

// Rate limit per grup: max 1 request tiap N detik
const lastReplyAt = new Map();

// Kata kunci yang menandakan pertanyaan menyinggung obrolan grup
const RECAP_KEYWORDS = /rekap|kemarin|tadi|barusan|tadi dibahas|dibahas|obrolan|chat|pesan|cek/i;

function rateLimitOk(groupId, seconds) {
  if (!seconds || seconds <= 0) return true;
  const now = Date.now();
  const last = lastReplyAt.get(groupId) || 0;
  if (now - last < seconds * 1000) return false;
  lastReplyAt.set(groupId, now);
  return true;
}

function buildConversationText(turns, memoryLimit) {
  return turns
    .slice(-memoryLimit)
    .map((t) => {
      if (t.role === 'assistant') return `Asisten: ${t.content}`;
      return `${t.sender_name || 'User'}: ${t.content}`;
    })
    .join('\n');
}

function shouldAttachGroupContext(question) {
  return RECAP_KEYWORDS.test(question);
}

async function getRecentGroupContext(groupId, minutes = 180) {
  const end = Date.now();
  const start = end - minutes * 60 * 1000;
  const rows = storage.getMessagesByDateRange(groupId, start, end);
  return formatChatHistory(rows);
}

export async function handleAssistant(sock, logger, config, message) {
  const groupId = message.key.remoteJid;
  const senderName = message.pushName || 'User';

  if (!rateLimitOk(groupId, Number(config.ASSISTANT_RATE_LIMIT_SECONDS || 5))) {
    logger.info({ groupId }, 'Assistant rate limited, skipping');
    return;
  }

  const memoryLimit = Number(config.CONVERSATION_MEMORY_LIMIT || 20);
  const recentTurns = storage.getRecentConversation(groupId, memoryLimit);
  const conversationText = buildConversationText(recentTurns, memoryLimit);

  let groupContext = '';
  if (shouldAttachGroupContext(message.text)) {
    groupContext = await getRecentGroupContext(groupId);
  }

  const contextParts = [];
  if (groupContext) contextParts.push(`Obrolan grup terbaru (${groupContext.split('\n').length} baris):\n${groupContext}`);
  const fullContext = contextParts.join('\n\n');

  logger.info({ groupId, question: message.text, withContext: !!fullContext }, 'Assistant request');

  try {
    const reply = await ollama.generateAssistantReply(message.text, fullContext || conversationText);
    const now = Date.now();

    storage.saveConversationTurn({ groupId, role: 'user', senderName, content: message.text, timestamp: now });
    storage.saveConversationTurn({ groupId, role: 'assistant', senderName: null, content: reply, timestamp: now });

    await sock.sendMessage(groupId, { text: reply }, { quoted: message.original });
    logger.info({ groupId }, 'Assistant reply sent');
  } catch (err) {
    logger.error({ err }, 'Assistant generation failed');
    await sock.sendMessage(groupId, { text: ollama.ollamaErrorHint(err) });
  }
}
