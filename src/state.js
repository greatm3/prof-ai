import { THINKING_WORDS } from './config.js';

const chats = new Map();
export function getChat(id) {
  if (!chats.has(id)) chats.set(id, { messages: [], lastReasoning: '', lastPhoto: null });
  return chats.get(id);
}

export const activeQuizzes = new Map();
export const activeDecks = new Map();

export const randWord = () => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];