import { bot, botUsername } from './src/telegram.js';
import { registerHandlers } from './src/handlers.js';
import { startAdminServer } from './src/admin.js';
import { QUIZ_QUESTIONS, FLASHCARD_COUNT } from './src/config.js';

registerHandlers();
startAdminServer();

console.log(`✓ Prof running as @${botUsername}`);
console.log(`✓ Quiz: ${QUIZ_QUESTIONS} questions, ONE at a time`);
console.log(`✓ Flashcards: ${FLASHCARD_COUNT} cards, reveal-and-advance`);
console.log(`✓ Photo → quiz / flashcards supported`);
console.log(`✓ Analytics: sessions, answers, /progress`);
console.log(`✓ Network retry: 3 attempts with backoff`);