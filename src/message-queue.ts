import { logger } from './logger.js';

/**
 * Per-chat FIFO message queue. Ensures only one message is processed
 * at a time per chat_id, preventing race conditions on sessions,
 * abort controllers, and conversation logs.
 */
class MessageQueue {
  private chains = new Map<string, Promise<void>>();
  private pending = new Map<string, number>();
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  /** Set a Telegram API reference so the queue can send typing indicators. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _botApi: { sendChatAction: (...args: any[]) => Promise<unknown> } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setBotApi(api: { sendChatAction: (...args: any[]) => Promise<unknown> }): void {
    this._botApi = api;
  }

  /** Start a typing indicator for queued messages waiting to be processed. */
  private startQueueTyping(chatId: string): void {
    if (this.typingIntervals.has(chatId) || !this._botApi) return;
    const numericId = parseInt(chatId);
    if (isNaN(numericId)) return;
    const api = this._botApi;
    // Send immediately, then refresh every 4 seconds
    api.sendChatAction(numericId, 'typing').catch(() => {});
    const iv = setInterval(() => {
      api.sendChatAction(numericId, 'typing').catch(() => {});
    }, 4000);
    this.typingIntervals.set(chatId, iv);
  }

  /** Stop the queue typing indicator. */
  private stopQueueTyping(chatId: string): void {
    const iv = this.typingIntervals.get(chatId);
    if (iv) {
      clearInterval(iv);
      this.typingIntervals.delete(chatId);
    }
  }

  /**
   * Enqueue a message handler for a given chat. Handlers for the same
   * chatId run sequentially in FIFO order. Different chatIds run in parallel.
   */
  enqueue(chatId: string, handler: () => Promise<void>): void {
    const queued = (this.pending.get(chatId) ?? 0) + 1;
    this.pending.set(chatId, queued);

    if (queued > 1) {
      logger.info({ chatId, queued }, 'Message queued (another is processing)');
      // Keep typing indicator alive while messages are queued
      this.startQueueTyping(chatId);
    }

    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.then(async () => {
      // This message is now active — stop queue typing (handler will start its own)
      this.stopQueueTyping(chatId);
      try {
        await handler();
      } catch (err) {
        logger.error({ err, chatId }, 'Unhandled message error');
      } finally {
        const remaining = (this.pending.get(chatId) ?? 1) - 1;
        if (remaining <= 0) {
          this.pending.delete(chatId);
          this.chains.delete(chatId);
          this.stopQueueTyping(chatId); // safety cleanup
        } else {
          this.pending.set(chatId, remaining);
        }
      }
    });

    this.chains.set(chatId, next);
  }

  /** Number of chats with pending messages. */
  get activeChats(): number {
    return this.chains.size;
  }

  /** Number of pending messages for a given chat. */
  queuedFor(chatId: string): number {
    return this.pending.get(chatId) ?? 0;
  }
}

export const messageQueue = new MessageQueue();
