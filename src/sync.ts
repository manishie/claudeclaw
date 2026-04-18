/**
 * Cross-platform memory sync — exports ClaudeClaw memories and handoffs
 * to a git-committed facts file that desktop Claude Code can read.
 *
 * Flow:
 *   1. User says "switching to desktop" (or "switching to telegram")
 *   2. Bot extracts handoff + exports memories to facts file
 *   3. Git commit + push
 *   4. Other side pulls and gets full context via session-start hook
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getRecentHighImportanceMemories, getLatestHandoff, type Memory, type SessionHandoff } from './db.js';
import { logger } from './logger.js';

// The shared facts file — desktop reads this via session-start.sh hook
const RESEARCH_REPO = '/home/admin/projects/research';
const FACTS_FILE = path.join(RESEARCH_REPO, '.claude', 'auto-extracted-facts.md');

function safeParse(json: string | null): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * Export recent memories and latest handoff to the shared facts file.
 * Returns the number of facts written.
 */
export function exportMemoriesToFile(chatId: string, agentId = 'main'): number {
  const lines: string[] = [];
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  lines.push(`# Auto-Extracted Facts`);
  lines.push(`> Last synced: ${now} UTC from ${agentId} agent`);
  lines.push('');

  // ── Latest handoff (session state) ─────────────────────────────────
  const handoff = getLatestHandoff(chatId, agentId);
  if (handoff) {
    const handoffAge = Math.floor(Date.now() / 1000) - handoff.created_at;
    if (handoffAge < 172800) { // 48h window
      lines.push('## Last Session Handoff');
      lines.push('');
      lines.push(`**Summary:** ${handoff.summary}`);
      if (handoff.current_topic) {
        lines.push(`**Topic:** ${handoff.current_topic}`);
      }

      const accomplished = safeParse(handoff.accomplished);
      if (accomplished.length > 0) {
        lines.push('');
        lines.push('**Accomplished:**');
        accomplished.forEach(a => lines.push(`- ${a}`));
      }

      const wip = safeParse(handoff.work_in_progress);
      if (wip.length > 0) {
        lines.push('');
        lines.push('**Work in Progress:**');
        wip.forEach(w => lines.push(`- ${w}`));
      }

      const decisions = safeParse(handoff.decisions);
      if (decisions.length > 0) {
        lines.push('');
        lines.push('**Decisions:**');
        decisions.forEach(d => {
          // Parse decision objects if they're structured
          if (typeof d === 'object' && d !== null) {
            const obj = d as unknown as { decision: string; reason: string };
            lines.push(`- ${obj.decision} — ${obj.reason}`);
          } else {
            lines.push(`- ${d}`);
          }
        });
      }

      const nextSteps = safeParse(handoff.next_steps);
      if (nextSteps.length > 0) {
        lines.push('');
        lines.push('**Next Steps:**');
        nextSteps.forEach(n => lines.push(`- ${n}`));
      }

      const openQuestions = safeParse(handoff.open_questions);
      if (openQuestions.length > 0) {
        lines.push('');
        lines.push('**Open Questions:**');
        openQuestions.forEach(q => lines.push(`- ${q}`));
      }

      const keyFacts = safeParse(handoff.key_facts);
      if (keyFacts.length > 0) {
        lines.push('');
        lines.push('**Key Facts:**');
        keyFacts.forEach(f => lines.push(`- ${f}`));
      }

      if (handoff.important_context) {
        lines.push('');
        lines.push(`**Context:** ${handoff.important_context}`);
      }

      lines.push('');
    }
  }

  // ── High-importance memories ───────────────────────────────────────
  const memories = getRecentHighImportanceMemories(chatId, 20);
  if (memories.length > 0) {
    lines.push('## Long-Term Memories');
    lines.push('');
    memories.forEach((m: Memory) => {
      const date = new Date(m.created_at * 1000).toISOString().slice(0, 10);
      const topics = safeParse(m.topics).join(', ');
      lines.push(`- **[${m.importance.toFixed(1)}]** ${m.summary}${topics ? ` (${topics})` : ''} — ${date}`);
    });
    lines.push('');
  }

  if (lines.length <= 3) {
    logger.info({ chatId }, 'No facts to export');
    return 0;
  }

  // Ensure directory exists
  const dir = path.dirname(FACTS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(FACTS_FILE, lines.join('\n'), 'utf-8');
  logger.info({ chatId, factsCount: lines.length }, 'Exported memories to facts file');
  return lines.length;
}

/**
 * Git commit and push the facts file to the shared repo.
 * Returns true if push succeeded, false otherwise.
 */
export function commitAndPushFacts(): boolean {
  try {
    // Stage the facts file
    execSync(`git add .claude/auto-extracted-facts.md`, {
      cwd: RESEARCH_REPO,
      timeout: 10000,
    });

    // Check if there are changes to commit
    const status = execSync('git diff --cached --name-only', {
      cwd: RESEARCH_REPO,
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();

    if (!status) {
      logger.info('No changes to facts file — skip commit');
      return true; // Nothing to push, but that's OK
    }

    // Commit
    execSync(
      `git -c user.name="ClaudeClaw" -c user.email="bot@claudeclaw" commit -m "sync: export memories for cross-platform handoff"`,
      { cwd: RESEARCH_REPO, timeout: 10000 },
    );

    // Push
    execSync('git push', {
      cwd: RESEARCH_REPO,
      timeout: 30000,
    });

    logger.info('Facts file committed and pushed');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to commit/push facts file');
    return false;
  }
}

/**
 * Full cross-platform switch: handoff + export + commit + push.
 * Called when user says "switching to desktop" or "switching to telegram".
 */
export async function performPlatformSwitch(
  chatId: string,
  agentId = 'main',
  extractHandoff: () => Promise<boolean>,
): Promise<{ handoffSaved: boolean; factsExported: number; pushed: boolean }> {
  // Step 1: Extract fresh handoff
  let handoffSaved = false;
  try {
    handoffSaved = await extractHandoff();
  } catch (err) {
    logger.error({ err }, 'Platform switch: handoff extraction failed');
  }

  // Step 2: Export memories + handoff to facts file
  const factsExported = exportMemoriesToFile(chatId, agentId);

  // Step 3: Commit and push
  const pushed = commitAndPushFacts();

  return { handoffSaved, factsExported, pushed };
}
