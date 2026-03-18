import { agentObsidianConfig, GOOGLE_API_KEY } from './config.js';
import {
  decayMemories,
  getLatestHandoff,
  getRecentConsolidations,
  getRecentHighImportanceMemories,
  logConversationTurn,
  pruneConversationLog,
  pruneSlackMessages,
  pruneWaMessages,
  searchConsolidations,
  searchMemories,
  touchMemory,
} from './db.js';
import { embedText } from './embeddings.js';
import { logger } from './logger.js';
import { ingestConversationTurn } from './memory-ingest.js';
import { buildObsidianContext } from './obsidian.js';

/**
 * Build a structured memory context string to prepend to the user's message.
 *
 * Three-layer retrieval:
 *   Layer 1: FTS5 keyword search on summary + raw_text + entities + topics (top 5)
 *   Layer 2: Recent high-importance memories (importance >= 0.5, top 5 by accessed_at)
 *   Layer 3: Relevant consolidation insights
 *
 * Deduplicates across layers. Returns formatted context with structure.
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
): Promise<string> {
  const seen = new Set<number>();
  const memLines: string[] = [];

  // Embed the query for vector search (async, adds ~200ms but gives semantic results)
  let queryEmbedding: number[] | undefined;
  if (GOOGLE_API_KEY) {
    try {
      queryEmbedding = await embedText(userMessage);
    } catch {
      // Embedding failure is non-fatal; falls back to keyword search
    }
  }

  // Layer 1: semantic search (embedding) with FTS5/LIKE fallback
  const searched = searchMemories(chatId, userMessage, 5, queryEmbedding);
  for (const mem of searched) {
    seen.add(mem.id);
    touchMemory(mem.id);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 2: recent high-importance memories (deduplicated)
  const recent = getRecentHighImportanceMemories(chatId, 5);
  for (const mem of recent) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    touchMemory(mem.id);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 3: consolidation insights
  const insightLines: string[] = [];
  const consolidations = searchConsolidations(chatId, userMessage, 2);
  if (consolidations.length === 0) {
    // Fall back to most recent consolidations
    const recentInsights = getRecentConsolidations(chatId, 2);
    for (const c of recentInsights) {
      insightLines.push(`- ${c.insight}`);
    }
  } else {
    for (const c of consolidations) {
      insightLines.push(`- ${c.insight}`);
    }
  }

  // Layer 4: Session handoff from previous session
  const handoff = getLatestHandoff(chatId);
  const handoffLines: string[] = [];
  if (handoff) {
    // Only inject handoffs from the last 48 hours (generous window for overnight work)
    const handoffAge = Math.floor(Date.now() / 1000) - handoff.created_at;
    if (handoffAge < 172800) {
      handoffLines.push(`Summary: ${handoff.summary}`);
      if (handoff.current_topic) {
        handoffLines.push(`Last topic: ${handoff.current_topic}`);
      }
      if (handoff.important_context) {
        handoffLines.push(`Context: ${handoff.important_context}`);
      }
      const accomplished = safeParse(handoff.accomplished);
      if (accomplished.length > 0) {
        handoffLines.push(`Accomplished: ${accomplished.map(a => '• ' + a).join('\n')}`);
      }
      const wip = safeParse(handoff.work_in_progress);
      if (wip.length > 0) {
        handoffLines.push(`Work in progress: ${wip.map(w => '• ' + w).join('\n')}`);
      }
      const decisions = safeParse(handoff.decisions);
      if (decisions.length > 0) {
        handoffLines.push(`Decisions: ${decisions.map(d => '• ' + d).join('\n')}`);
      }
      const nextSteps = safeParse(handoff.next_steps);
      if (nextSteps.length > 0) {
        handoffLines.push(`Next steps: ${nextSteps.map(n => '• ' + n).join('\n')}`);
      }
      const openQuestions = safeParse(handoff.open_questions);
      if (openQuestions.length > 0) {
        handoffLines.push(`Open questions: ${openQuestions.map(q => '• ' + q).join('\n')}`);
      }
      const blockers = safeParse(handoff.blockers);
      if (blockers.length > 0) {
        handoffLines.push(`Blockers: ${blockers.map(b => '• ' + b).join('\n')}`);
      }
      const keyFacts = safeParse(handoff.key_facts);
      if (keyFacts.length > 0) {
        handoffLines.push(`Key facts: ${keyFacts.map(f => '• ' + f).join('\n')}`);
      }
    }
  }

  if (memLines.length === 0 && insightLines.length === 0 && handoffLines.length === 0 && !agentObsidianConfig) {
    return '';
  }

  const parts: string[] = [];

  if (memLines.length > 0 || insightLines.length > 0 || handoffLines.length > 0) {
    const blocks: string[] = ['[Memory context]'];

    if (handoffLines.length > 0) {
      blocks.push('Previous session handoff:');
      blocks.push(...handoffLines);
      blocks.push('');
    }
    if (memLines.length > 0) {
      blocks.push('Relevant memories:');
      blocks.push(...memLines);
    }
    if (insightLines.length > 0) {
      blocks.push('');
      blocks.push('Insights:');
      blocks.push(...insightLines);
    }
    blocks.push('[End memory context]');
    parts.push(blocks.join('\n'));
  }

  const obsidianBlock = buildObsidianContext(agentObsidianConfig);
  if (obsidianBlock) parts.push(obsidianBlock);

  return parts.join('\n\n');
}

/**
 * Process a conversation turn: log it and fire async memory extraction.
 * Called AFTER Claude responds, with both user message and Claude's response.
 *
 * The conversation log is written synchronously (for /respin support).
 * Memory extraction via Gemini is fire-and-forget (never blocks the response).
 */
export function saveConversationTurn(
  chatId: string,
  userMessage: string,
  claudeResponse: string,
  sessionId?: string,
  agentId = 'main',
): void {
  try {
    // Always log full conversation to conversation_log (for /respin)
    logConversationTurn(chatId, 'user', userMessage, sessionId, agentId);
    logConversationTurn(chatId, 'assistant', claudeResponse, sessionId, agentId);
  } catch (err) {
    logger.error({ err }, 'Failed to log conversation turn');
  }

  // Fire-and-forget: LLM-powered memory extraction via Gemini
  // This runs async and never blocks the user's response
  void ingestConversationTurn(chatId, userMessage, claudeResponse).catch((err) => {
    logger.error({ err }, 'Memory ingestion fire-and-forget failed');
  });
}

/**
 * Run the daily decay sweep. Call once on startup and every 24h.
 * Also prunes old conversation_log entries to prevent unbounded growth.
 *
 * MESSAGE RETENTION POLICY:
 * WhatsApp and Slack messages are auto-deleted after 3 days.
 * This is a security measure: message bodies contain personal
 * conversations that must not persist on disk indefinitely.
 */
export function runDecaySweep(): void {
  decayMemories();
  pruneConversationLog(500);

  // Enforce 3-day retention on messaging data
  const wa = pruneWaMessages(3);
  const slack = pruneSlackMessages(3);
  if (wa.messages + wa.outbox + wa.map + slack > 0) {
    logger.info(
      { wa_messages: wa.messages, wa_outbox: wa.outbox, wa_map: wa.map, slack },
      'Retention pruning complete',
    );
  }
}

/** Safely parse a JSON array string, returning [] on failure. */
function safeParse(json: string): string[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
