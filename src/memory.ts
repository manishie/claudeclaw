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
import { logger } from './logger.js';
import { saveMastraMessages } from './mastra-memory.js';
import { buildObsidianContext } from './obsidian.js';

/**
 * Build a structured memory context string to prepend to the user's message.
 *
 * Retrieval layers:
 *   Layer 1: Legacy FTS5/vector search on old memories (top 5) - will fade as salience decays
 *   Layer 2: Recent high-importance legacy memories (top 5)
 *   Layer 3: Legacy consolidation insights
 *   Layer 4: Session handoff from previous session (Gemini-powered, kept)
 *
 * NOTE: Mastra's Observational Memory manages its own context injection
 * through the thread history. The legacy layers above will gradually
 * become empty as old memories decay and no new Gemini extractions occur.
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
): Promise<string> {
  const seen = new Set<number>();
  const memLines: string[] = [];

  // Layer 1: legacy FTS5/LIKE search (no more embedding queries - Mastra handles semantic)
  const searched = searchMemories(chatId, userMessage, 5);
  for (const mem of searched) {
    seen.add(mem.id);
    touchMemory(mem.id);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 2: recent high-importance legacy memories (deduplicated)
  const recent = getRecentHighImportanceMemories(chatId, 5);
  for (const mem of recent) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    touchMemory(mem.id);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 3: legacy consolidation insights
  const insightLines: string[] = [];
  const consolidations = searchConsolidations(chatId, userMessage, 2);
  if (consolidations.length === 0) {
    const recentInsights = getRecentConsolidations(chatId, 2);
    for (const c of recentInsights) {
      insightLines.push(`- ${c.insight}`);
    }
  } else {
    for (const c of consolidations) {
      insightLines.push(`- ${c.insight}`);
    }
  }

  // Layer 4: Session handoff from previous session (kept - Mastra doesn't do this)
  const handoff = getLatestHandoff(chatId);
  const handoffLines: string[] = [];
  if (handoff) {
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
 * Process a conversation turn: log it and save to Mastra Memory.
 * Called AFTER Claude responds, with both user message and Claude's response.
 *
 * - Conversation log is written synchronously (for /respin support)
 * - Mastra Memory save is fire-and-forget (never blocks the response)
 *   Mastra's Observational Memory handles extraction + consolidation automatically
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

  // Fire-and-forget: Save to Mastra Memory (replaces Gemini extraction)
  // Mastra's Observational Memory handles extraction + consolidation automatically
  void saveMastraMessages(chatId, userMessage, claudeResponse).catch((err) => {
    logger.error({ err }, 'Mastra Memory save fire-and-forget failed');
  });
}

/**
 * Run the daily decay sweep. Call once on startup and every 24h.
 * Also prunes old conversation_log entries to prevent unbounded growth.
 *
 * NOTE: Legacy memory decay continues to run to gradually phase out
 * old Gemini-extracted memories. Once all legacy memories have decayed
 * below threshold, this can be simplified.
 *
 * MESSAGE RETENTION POLICY:
 * WhatsApp and Slack messages are auto-deleted after 3 days.
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
