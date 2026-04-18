import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import ioredis from 'ioredis';
const { Redis } = ioredis;

import { AGENT_ID, ALLOWED_CHAT_ID } from './config.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
} from './db.js';
import { logger } from './logger.js';
import { runAgent } from './agent.js';
import { formatForTelegram } from './bot.js';
import { traceScheduledTask } from './langfuse.js';
import { computeNextRun } from './scheduler.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const REDIS_CONNECTION = { host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null };
const QUEUE_NAME = 'claudeclaw-tasks';

let connection: InstanceType<typeof Redis> | null = null;
let taskQueue: Queue | null = null;
let taskWorker: Worker | null = null;
let sender: Sender;
let schedulerAgentId = 'main';

/**
 * Initialize the BullMQ-based scheduler. Drop-in replacement for the
 * SQLite-polling scheduler.
 *
 * Architecture: We still poll the SQLite scheduled_tasks table for due tasks
 * (preserving the existing task management UI/CLI), but dispatch them through
 * BullMQ for reliable execution with retries, timeouts, and concurrency control.
 */
export async function initBullMQScheduler(send: Sender, agentId = 'main'): Promise<void> {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — BullMQ scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }

  // Initialize Redis connection
  connection = new Redis(REDIS_CONNECTION);

  connection.on('error', (err: Error) => {
    logger.error({ err }, 'BullMQ Redis connection error');
  });

  // Create the task queue
  taskQueue = new Queue(QUEUE_NAME, { connection });

  // Create the worker that processes scheduled tasks
  taskWorker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { taskId, prompt, schedule } = job.data;
      const startMs = Date.now();

      logger.info({ taskId, prompt: prompt.slice(0, 60), jobId: job.id }, 'Processing scheduled task');

      await sender(`Scheduled task running: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        const result = await runAgent(prompt, undefined, () => {}, undefined, undefined, abortController);
        clearTimeout(timeout);

        const durationMs = Date.now() - startMs;
        const nextRun = computeNextRun(schedule);

        if (result.aborted) {
          updateTaskAfterRun(taskId, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${prompt.slice(0, 60)}..." — killed.`);
          traceScheduledTask({ taskId, prompt, status: 'timeout', durationMs });
          logger.warn({ taskId }, 'Task timed out');
          return;
        }

        const text = result.text?.trim() || 'Task completed with no output.';
        await sender(formatForTelegram(text));

        // Inject task output into the active chat session
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${prompt}`, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        updateTaskAfterRun(taskId, nextRun, text, 'success');
        traceScheduledTask({ taskId, prompt, status: 'success', output: text, durationMs });

        logger.info({ taskId, nextRun, durationMs }, 'Task complete');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        const nextRun = computeNextRun(schedule);
        updateTaskAfterRun(taskId, nextRun, errMsg.slice(0, 500), 'failed');
        traceScheduledTask({ taskId, prompt, status: 'failed', durationMs: Date.now() - startMs });

        logger.error({ err, taskId }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
        throw err; // Let BullMQ handle the retry
      }
    },
    {
      connection,
      concurrency: 1, // One task at a time (matches current behavior)
      removeOnComplete: { count: 50 }, // Keep last 50 completed for debugging
      removeOnFail: { count: 20 },
    },
  );

  taskWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id, taskId: job?.data?.taskId }, 'BullMQ job failed');
  });

  taskWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, taskId: job.data?.taskId }, 'BullMQ job completed');
  });

  // Poll SQLite for due tasks every 60s and enqueue them into BullMQ
  // This bridges the existing DB-backed task management with BullMQ execution
  setInterval(() => void pollAndEnqueue(), 60_000);

  logger.info({ agentId }, 'BullMQ scheduler started (polling every 60s, Redis-backed execution)');
}

/**
 * Poll SQLite for due tasks and add them to the BullMQ queue.
 */
async function pollAndEnqueue(): Promise<void> {
  if (!taskQueue) return;

  const tasks = getDueTasks(schedulerAgentId);
  if (tasks.length === 0) return;

  logger.info({ count: tasks.length }, 'Enqueuing due tasks to BullMQ');

  for (const task of tasks) {
    const nextRun = computeNextRun(task.schedule);
    markTaskRunning(task.id, nextRun);

    await taskQueue.add(
      'scheduled-task',
      {
        taskId: task.id,
        prompt: task.prompt,
        schedule: task.schedule,
      },
      {
        jobId: `task-${task.id}-${Date.now()}`,
        attempts: 2, // Retry once on failure
        backoff: {
          type: 'exponential',
          delay: 30_000, // 30s initial backoff
        },
        removeOnComplete: true,
      },
    );

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Task enqueued');
  }
}

/**
 * Enqueue an ad-hoc job (e.g., research dispatch).
 * Returns the job so the caller can track its completion.
 */
export async function enqueueJob(
  name: string,
  data: Record<string, unknown>,
  opts?: { attempts?: number; timeout?: number; priority?: number },
): Promise<Job | null> {
  if (!taskQueue) {
    logger.warn('BullMQ not initialized — cannot enqueue job');
    return null;
  }

  const job = await taskQueue.add(name, data, {
    jobId: `${name}-${Date.now()}`,
    attempts: opts?.attempts ?? 1,
    priority: opts?.priority,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 20 },
  });

  logger.info({ jobId: job.id, name }, 'Ad-hoc job enqueued');
  return job;
}

/**
 * Get queue health stats for the /status command.
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
} | null> {
  if (!taskQueue) return null;
  const [waiting, active, completed, failed] = await Promise.all([
    taskQueue.getWaitingCount(),
    taskQueue.getActiveCount(),
    taskQueue.getCompletedCount(),
    taskQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

/**
 * Graceful shutdown — close worker and connection.
 */
export async function shutdownBullMQ(): Promise<void> {
  if (taskWorker) {
    await taskWorker.close();
    logger.info('BullMQ worker closed');
  }
  if (connection) {
    connection.disconnect();
    logger.info('BullMQ Redis disconnected');
  }
}
