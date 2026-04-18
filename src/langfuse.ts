import { Langfuse } from 'langfuse';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

let langfuse: Langfuse | null = null;

/**
 * Initialize Langfuse client. Call once at startup.
 * Gracefully no-ops if keys aren't configured.
 */
export function initLangfuse(): boolean {
  const keys = readEnvFile(['LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_BASE_URL']);

  if (!keys.LANGFUSE_SECRET_KEY || !keys.LANGFUSE_PUBLIC_KEY) {
    logger.info('Langfuse keys not configured — observability disabled');
    return false;
  }

  langfuse = new Langfuse({
    secretKey: keys.LANGFUSE_SECRET_KEY,
    publicKey: keys.LANGFUSE_PUBLIC_KEY,
    baseUrl: keys.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
    // Flush events in batches to avoid blocking the main loop
    flushAt: 15,
    flushInterval: 10000, // 10s
  });

  logger.info('Langfuse initialized');
  return true;
}

/**
 * Create a trace for a user message turn.
 * Returns a trace object that can be used to add spans/generations,
 * or null if Langfuse is not configured.
 */
export function traceTurn(opts: {
  chatId: string;
  sessionId?: string;
  userId?: string;
  message: string;
  model?: string;
  agentId?: string;
}) {
  if (!langfuse) return null;

  return langfuse.trace({
    name: 'telegram-turn',
    sessionId: opts.sessionId || opts.chatId,
    userId: opts.userId || opts.chatId,
    input: opts.message,
    metadata: {
      agentId: opts.agentId,
      model: opts.model,
      chatId: opts.chatId,
    },
  });
}

/**
 * Record LLM generation details (tokens, cost, latency) on a trace.
 */
export function recordGeneration(
  trace: ReturnType<typeof traceTurn>,
  opts: {
    output: string | null;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalCostUsd: number;
    durationMs: number;
    didCompact: boolean;
  },
) {
  if (!trace) return;

  trace.generation({
    name: 'claude-agent',
    model: opts.model || 'claude-sonnet-4-20250514',
    input: 'see trace input',
    output: opts.output || '',
    usage: {
      input: opts.inputTokens,
      output: opts.outputTokens,
      total: opts.inputTokens + opts.outputTokens,
      // Langfuse doesn't have a native cache field, use metadata
    },
    metadata: {
      cacheReadTokens: opts.cacheReadTokens,
      totalCostUsd: opts.totalCostUsd,
      didCompact: opts.didCompact,
    },
    completionStartTime: new Date(Date.now() - opts.durationMs),
    endTime: new Date(),
  });

  // Update trace with output
  trace.update({
    output: opts.output || '',
    metadata: {
      totalCostUsd: opts.totalCostUsd,
      durationMs: opts.durationMs,
    },
  });
}

/**
 * Record a scheduled task execution.
 */
export function traceScheduledTask(opts: {
  taskId: string;
  prompt: string;
  status: 'success' | 'failed' | 'timeout';
  output?: string;
  durationMs?: number;
}) {
  if (!langfuse) return;

  const trace = langfuse.trace({
    name: 'scheduled-task',
    metadata: {
      taskId: opts.taskId,
      status: opts.status,
      durationMs: opts.durationMs,
    },
    input: opts.prompt,
    output: opts.output,
    tags: ['scheduled', opts.status],
  });

  return trace;
}

/**
 * Flush pending events. Call on shutdown.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (!langfuse) return;
  try {
    await langfuse.shutdownAsync();
    logger.info('Langfuse flushed and shut down');
  } catch (err) {
    logger.error({ err }, 'Langfuse shutdown error');
  }
}

export { langfuse };
