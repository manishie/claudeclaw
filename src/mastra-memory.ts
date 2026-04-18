/**
 * Mastra Memory Integration
 *
 * Replaces custom Gemini-powered per-turn extraction and consolidation
 * with Mastra's Memory system (including Observational Memory).
 *
 * What's replaced:
 *   - Per-turn Gemini extraction (memory-ingest.ts ingestConversationTurn)
 *   - 30-min Gemini consolidation (memory-consolidate.ts)
 *   - Custom embedding generation (embeddings.ts)
 *
 * What's kept:
 *   - Session handoff extraction (still uses Gemini - Mastra has no equivalent)
 *   - Conversation logging to our DB (for /respin support)
 *   - FTS5 keyword search as supplementary layer
 *   - Salience decay on legacy memories
 */

import { Memory } from '@mastra/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { randomUUID } from 'crypto';
import path from 'path';
import { logger } from './logger.js';
import { GOOGLE_API_KEY } from './config.js';

// ── Singleton instances ────────────────────────────────────────────

let _memory: Memory | null = null;
let _storage: LibSQLStore | null = null;
let _initialized = false;

const MASTRA_DB_PATH = path.resolve(process.cwd(), 'store', 'mastra.db');

/**
 * Initialize Mastra Memory. Call once at startup.
 */
export async function initMastraMemory(): Promise<void> {
  if (_initialized) return;

  try {
    _storage = new LibSQLStore({
      id: 'claudeclaw',
      url: `file:${MASTRA_DB_PATH}`,
    });

    const vector = new LibSQLVector({
      id: 'claudeclaw-vec',
      url: `file:${MASTRA_DB_PATH}`,
    });

    await _storage.init();

    _memory = new Memory({
      storage: _storage,
      vector,
      options: {
        lastMessages: 30,
        semanticRecall: false, // Start without semantic recall; add embedder later if needed
        observationalMemory: GOOGLE_API_KEY
          ? {
              model: { provider: 'google', name: 'gemini-2.5-flash' } as any,
            }
          : true, // Use default model if no Google API key
      },
    });

    _initialized = true;
    logger.info({ dbPath: MASTRA_DB_PATH }, 'Mastra Memory initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Mastra Memory');
    throw err;
  }
}

/**
 * Get the Memory instance. Throws if not initialized.
 */
export function getMastraMemory(): Memory {
  if (!_memory) throw new Error('Mastra Memory not initialized. Call initMastraMemory() first.');
  return _memory;
}

/**
 * Get or create a thread for a chat. Each Telegram chat maps to one Mastra thread.
 * Thread ID = chat ID for simplicity.
 */
export async function getOrCreateThread(
  chatId: string,
  resourceId: string,
): Promise<string> {
  if (!_storage) throw new Error('Mastra storage not initialized');

  const memStore = await _storage.getStore('memory');
  if (!memStore) throw new Error('Mastra memory store not available');

  const threadId = `chat-${chatId}`;

  try {
    const existing = await memStore.getThreadById({ threadId });
    if (existing) return threadId;
  } catch {
    // Thread doesn't exist yet
  }

  try {
    await memStore.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: `Chat ${chatId}`,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'active',
      } as any,
    });
    logger.info({ chatId, threadId }, 'Created Mastra thread');
  } catch (err: any) {
    // Thread may already exist from a race condition
    if (!err.message?.includes('UNIQUE constraint')) {
      throw err;
    }
  }

  return threadId;
}

/**
 * Save a conversation turn to Mastra Memory.
 * Replaces the Gemini-powered ingestConversationTurn.
 *
 * Mastra's Observational Memory will automatically:
 * - Store messages with thread context
 * - Run Observer agent to extract observations
 * - Run Reflector agent to consolidate over time
 */
export async function saveMastraMessages(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  if (!_memory || !_storage) {
    logger.warn('Mastra Memory not initialized, skipping message save');
    return;
  }

  try {
    const resourceId = `user-${chatId}`;
    const threadId = await getOrCreateThread(chatId, resourceId);

    const now = new Date();
    await (_memory.saveMessages as any)({
      threadId,
      resourceId,
      messages: [
        {
          id: randomUUID(),
          threadId,
          resourceId,
          role: 'user',
          createdAt: now,
          content: { format: 2, parts: [{ type: 'text', text: userMessage }] },
          type: 'text',
        },
        {
          id: randomUUID(),
          threadId,
          resourceId,
          role: 'assistant',
          createdAt: now,
          content: { format: 2, parts: [{ type: 'text', text: assistantResponse }] },
          type: 'text',
        },
      ],
    });

    logger.debug({ chatId, threadId }, 'Saved messages to Mastra Memory');
  } catch (err) {
    // Never block the bot on memory failure
    logger.error({ err, chatId }, 'Failed to save messages to Mastra Memory');
  }
}

/**
 * Recall relevant context from Mastra Memory for a given chat.
 * Returns formatted context string to prepend to user message.
 */
export async function recallMastraContext(
  chatId: string,
): Promise<{ messages: any[]; workingMemory?: string } | null> {
  if (!_memory || !_storage) return null;

  try {
    const resourceId = `user-${chatId}`;
    const threadId = await getOrCreateThread(chatId, resourceId);

    const result = await _memory.recall({
      threadId,
      resourceId,
    });

    return result;
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to recall Mastra Memory context');
    return null;
  }
}

/**
 * Reset the thread for a chat (e.g., on /newchat).
 * Creates a new thread while preserving the old one.
 */
export async function resetMastraThread(chatId: string): Promise<string> {
  if (!_storage) throw new Error('Mastra storage not initialized');

  const memStore = await _storage.getStore('memory');
  if (!memStore) throw new Error('Mastra memory store not available');

  const resourceId = `user-${chatId}`;
  const newThreadId = `chat-${chatId}-${Date.now()}`;

  try {
    await memStore.saveThread({
      thread: {
        id: newThreadId,
        resourceId,
        title: `Chat ${chatId} (reset)`,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'active',
      } as any,
    });
    logger.info({ chatId, newThreadId }, 'Reset Mastra thread');
  } catch (err) {
    logger.error({ err }, 'Failed to reset Mastra thread');
    throw err;
  }

  return newThreadId;
}
