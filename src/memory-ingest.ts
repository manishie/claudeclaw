import { generateContent, parseJsonResponse } from './gemini.js';
import { embedText } from './embeddings.js';
import { saveStructuredMemory, saveMemoryEmbedding, saveSessionHandoff, getRecentConversation, type ConversationTurn } from './db.js';
import { logger } from './logger.js';

interface ExtractionResult {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

const EXTRACTION_PROMPT = `You are a memory extraction agent. Given a conversation exchange between a user and their AI assistant, decide if it contains information worth remembering long-term.

SKIP (return {"skip": true}) if:
- The message is just an acknowledgment (ok, yes, no, got it, thanks, send it, do it)
- It's a command with no lasting context (/chatid, /help, checkpoint, convolife, etc)
- It's ephemeral task execution (send this email, check my calendar, read this message, draft a response)
- The content is only relevant to this exact moment
- It's a greeting or small talk with no substance
- It's a one-off action request like "shorten that", "generate 3 ideas", "look up X", "draft a reply" — these are tasks, not memories
- It's a correction of a typo or minor instruction adjustment
- It's asking for information or a status check ("how much did we make", "what's trending", "what time is it")

EXTRACT if the exchange contains:
- User preferences, habits, or personal facts
- Decisions or policies (how to handle X going forward)
- Important relationships or contacts and how the user relates to them
- Project context that will matter in future sessions
- Corrections to the assistant's behavior (feedback on approach)
- Business rules or workflows
- Recurring patterns or routines
- Technical preferences or architectural decisions
- Emotional context about relationships or situations

If extracting, return JSON:
{
  "skip": false,
  "summary": "1-2 sentence summary of what to remember",
  "entities": ["entity1", "entity2"],
  "topics": ["topic1", "topic2"],
  "importance": 0.0-1.0
}

Importance guide:
- 0.8-1.0: Core identity, strong preferences, critical business rules, relationship dynamics
- 0.5-0.7: Useful context, project details, moderate preferences, workflow patterns
- 0.2-0.4: Nice to know, minor details, one-off context that might be relevant later

User message: {USER_MESSAGE}
Assistant response: {ASSISTANT_RESPONSE}`;

/**
 * Analyze a conversation turn and extract structured memory if warranted.
 * Called async (fire-and-forget) after the assistant responds.
 * Returns true if a memory was saved, false if skipped.
 */
export async function ingestConversationTurn(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<boolean> {
  // Hard filter: skip very short messages and commands
  if (userMessage.length <= 15 || userMessage.startsWith('/')) return false;

  try {
    const prompt = EXTRACTION_PROMPT
      .replace('{USER_MESSAGE}', userMessage.slice(0, 2000))
      .replace('{ASSISTANT_RESPONSE}', assistantResponse.slice(0, 2000));

    const raw = await generateContent(prompt);
    const result = parseJsonResponse<ExtractionResult & { skip?: boolean }>(raw);

    if (!result || result.skip) return false;

    // Validate required fields
    if (!result.summary || typeof result.importance !== 'number') {
      logger.warn({ result }, 'Gemini extraction missing required fields');
      return false;
    }

    // Hard filter: don't save low importance (0.3 threshold kills borderline noise)
    if (result.importance < 0.3) return false;

    // Clamp importance to valid range
    const importance = Math.max(0, Math.min(1, result.importance));

    const memoryId = saveStructuredMemory(
      chatId,
      userMessage,
      result.summary,
      result.entities ?? [],
      result.topics ?? [],
      importance,
      'conversation',
    );

    // Generate and store embedding (async, non-blocking for the save itself)
    try {
      const embeddingText = `${result.summary} ${(result.entities ?? []).join(' ')} ${(result.topics ?? []).join(' ')}`;
      const embedding = await embedText(embeddingText);
      if (embedding.length > 0) {
        saveMemoryEmbedding(memoryId, embedding);
      }
    } catch (embErr) {
      // Embedding failure is non-fatal; memory is still saved, just not vector-searchable
      logger.warn({ err: embErr, memoryId }, 'Failed to generate embedding for memory');
    }

    logger.info(
      { chatId, importance, topics: result.topics, summary: result.summary.slice(0, 80) },
      'Memory ingested',
    );
    return true;
  } catch (err) {
    // Gemini failure should never block the bot
    logger.error({ err }, 'Memory ingestion failed (Gemini)');
    return false;
  }
}

// ── Session Handoff Extraction ──────────────────────────────────────

interface HandoffResult {
  summary: string;
  current_topic: string | null;
  accomplished: string[];
  work_in_progress: string[];
  decisions: string[];
  next_steps: string[];
  open_questions: string[];
  blockers: string[];
  key_facts: string[];
  important_context: string | null;
}

const HANDOFF_PROMPT = `You are a session handoff agent. A conversation session between a user and their AI assistant is ending (context window filling up). Your job is to create a comprehensive structured handoff so the NEXT session starts with FULL awareness of everything that happened — no context or meaning should be lost.

Analyze the conversation turns below and extract ALL of the following:

1. **summary**: 2-4 sentence summary covering what was discussed and accomplished.
2. **current_topic**: The primary topic being worked on (null if unclear).
3. **accomplished**: Array of things completed this session. Be specific — include file names, function names, config changes, exact values. Example: "Fixed Gemini model from gemini-2.0-flash to gemini-2.5-flash in src/gemini.ts"
4. **work_in_progress**: Array of things started but not finished. Include exactly where work stopped and what the next action is. Example: "Implementing handoff extraction — DB table created, prompt not yet enriched"
5. **decisions**: Array of decisions made. Include what was chosen AND what was rejected and why. Example: "Chose to use Gemini 2.5 Flash over GPT-4-mini for memory extraction because of free API tier and JSON mode support"
6. **next_steps**: Array of things that need to happen next, in priority order. Be specific and actionable. Example: "Lower handoff threshold from 80% to 70% in bot.ts line 389"
7. **open_questions**: Array of unresolved questions that need user input or further investigation. Example: "Should we keep per-turn memory extraction alongside the structured handoff?"
8. **blockers**: Array of things blocked on external dependencies. Example: "Hub changes need git push from VPS and pull on desktop" — or empty array if none.
9. **key_facts**: Array of important numbers, values, paths, or technical details the next session needs. Example: "Context limit is 1M tokens for Opus 4.6", "ClaudeClaw DB at /home/admin/claudeclaw/store/claudeclaw.db"
10. **important_context**: Freeform context about the user's situation, communication mode, constraints. Example: "User is driving and communicating via voice notes. Keep responses concise." Null if nothing special.

RULES:
- Be EXHAUSTIVE — capture everything. The next session has ZERO context without this.
- Use exact file paths, function names, variable names, and values — never paraphrase technical details.
- For decisions: always include the "why" — rationale matters more than the choice itself.
- Every field must have content or be an empty array/null. Do not omit fields.
- Prioritize: what would someone need to know to seamlessly continue this work?

Return JSON:
{
  "summary": "...",
  "current_topic": "..." or null,
  "accomplished": ["item1", "item2"],
  "work_in_progress": ["item1 — stopped at X, next: Y"],
  "decisions": ["chose X over Y because Z"],
  "next_steps": ["step1 (priority)", "step2"],
  "open_questions": ["question1"],
  "blockers": ["blocker1"],
  "key_facts": ["fact1", "fact2"],
  "important_context": "..." or null
}

CONVERSATION:
{CONVERSATION}`;

/**
 * Extract a structured handoff from recent conversation before session reset.
 * Called synchronously before clearSession() — must complete before the session is cleared.
 * Returns true if a handoff was saved, false if extraction failed.
 */
export async function extractSessionHandoff(
  chatId: string,
  sessionId: string | undefined,
  agentId = 'main',
): Promise<boolean> {
  try {
    // Grab recent conversation turns (up to 30 — enough for context, not too much for Gemini)
    const turns = getRecentConversation(chatId, 30);
    if (turns.length < 4) {
      logger.info({ chatId, turnCount: turns.length }, 'Too few turns for handoff extraction');
      return false;
    }

    // Format conversation for the prompt (chronological order)
    const chronological = [...turns].reverse();
    const formatted = chronological.map((t: ConversationTurn) => {
      const role = t.role === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages
      const content = t.content.length > 800 ? t.content.slice(0, 800) + '...' : t.content;
      return `[${role}]: ${content}`;
    }).join('\n\n');

    const prompt = HANDOFF_PROMPT.replace('{CONVERSATION}', formatted.slice(0, 8000));

    const raw = await generateContent(prompt);
    const result = parseJsonResponse<HandoffResult>(raw);

    if (!result || !result.summary) {
      logger.warn({ raw: raw.slice(0, 200) }, 'Handoff extraction returned invalid result');
      return false;
    }

    const handoffId = saveSessionHandoff(
      chatId,
      sessionId,
      result.summary,
      result.current_topic ?? null,
      result.accomplished ?? [],
      result.work_in_progress ?? [],
      result.decisions ?? [],
      result.next_steps ?? [],
      result.open_questions ?? [],
      result.blockers ?? [],
      result.key_facts ?? [],
      result.important_context ?? null,
      agentId,
    );

    logger.info(
      { chatId, handoffId, summary: result.summary.slice(0, 100) },
      'Session handoff saved',
    );
    return true;
  } catch (err) {
    // Handoff failure should never prevent session reset
    logger.error({ err }, 'Session handoff extraction failed');
    return false;
  }
}
