import 'dotenv/config';

export const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
export const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3001);

export const MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
export const MAX_CONTEXT_MESSAGES = 20;
export const QUIZ_QUESTIONS = 10;
export const QUIZ_MIN_ACCEPT = 8;
export const FLASHCARD_COUNT = 5;
export const FLASHCARD_MIN_ACCEPT = 4;
export const PHOTO_TTL_MS = 15 * 60 * 1000;

export const THINKING_WORDS = [
  'musing', 'cultivating', 'gallivanting', 'pondering', 'conjuring',
  'weaving', 'rummaging', 'spelunking', 'tinkering', 'meandering',
  'deciphering', 'foraging', 'contemplating', 'summoning', 'distilling',
  'marinating', 'percolating', 'wandering', 'whittling', 'unraveling',
  'stewing', 'sifting', 'assembling', 'reaching', 'coaxing',
  'charting', 'humming', 'unfurling', 'tracing', 'threading',
  'sketching', 'brewing', 'gathering', 'aligning', 'sensing',
  'soliloquizing', 'daydreaming', 'noodling', 'mulling', 'simmering',
];