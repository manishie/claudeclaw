import { spawn } from 'child_process';
import fs from 'fs';
import type { Context, Api, RawApi } from 'grammy';
import type { ClawPlugin, ClawAPI, MessageContext } from '../../../plugin-api.js';
import { logger } from '../../../logger.js';

// ── Marker extraction ─────────────────────────────────────────────────

interface FileMarker {
  type: 'document' | 'photo';
  filePath: string;
  caption?: string;
}

interface ExtractResult {
  text: string;
  files: FileMarker[];
  reactions: string[];
}

/**
 * Extract [SEND_FILE:path], [SEND_PHOTO:path], and [REACT:emoji] markers.
 * Returns cleaned text with markers stripped.
 */
function extractMarkers(text: string): ExtractResult {
  const files: FileMarker[] = [];
  const reactions: string[] = [];

  const filePattern = /\[SEND_(FILE|PHOTO):([^\]\|]+)(?:\|([^\]]*))?\]/g;
  const reactionPattern = /\[REACT:([^\]]+)\]/g;

  let cleaned = text.replace(filePattern, (_, kind: string, filePath: string, caption?: string) => {
    files.push({
      type: kind === 'PHOTO' ? 'photo' : 'document',
      filePath: filePath.trim(),
      caption: caption?.trim() || undefined,
    });
    return '';
  });

  cleaned = cleaned.replace(reactionPattern, (_, emoji: string) => {
    reactions.push(emoji.trim());
    return '';
  });

  const trimmed = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { text: trimmed, files, reactions };
}

// ── Research detection ────────────────────────────────────────────────

const RESEARCH_PATTERN = /\b(research topic|deep research|research advisor|run.*advisor|full research|comprehensive research)\b/i;
const RESEARCH_WRAPPER = process.env.RESEARCH_WRAPPER_PATH || '';

/**
 * Detect research requests and launch the wrapper script directly.
 * Returns { handled: true } to short-circuit — Claude never sees it.
 */
async function handleResearchRequest(mc: MessageContext): Promise<{ handled: true } | undefined> {
  if (!RESEARCH_PATTERN.test(mc.message) || !RESEARCH_WRAPPER) return undefined;

  // Extract topic from message (look for known patterns)
  const topicMatch = mc.message.match(/(?:on|for|about|topic)\s+["']?([a-z][\w/.-]+)/i)
    ?? mc.message.match(/research\s+(?:advisor\s+)?(?:on\s+)?["']?([a-z][\w/.-]+)/i);

  if (!topicMatch) {
    // Can't determine topic — let Claude handle it so it can ask
    return undefined;
  }

  const topic = topicMatch[1].replace(/["']/g, '');

  try {
    // Send ack to user
    await mc.ctx.reply(`🔬 Research advisor launching for **${topic}**. I'll message you when the report is ready.`, { parse_mode: 'Markdown' });

    // Spawn wrapper completely detached
    const child = spawn('bash', [RESEARCH_WRAPPER, topic, ''], {
      cwd: '/home/node/projects/research',
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();

    logger.info({ topic, pid: child.pid }, 'Research wrapper launched');

    // Set up a poller to notify when done
    const statusFile = '/tmp/research-status.txt';
    const checkInterval = setInterval(async () => {
      try {
        const status = fs.readFileSync(statusFile, 'utf-8').trim();
        if (status.startsWith('Complete')) {
          clearInterval(checkInterval);
          const resultFile = '/tmp/research-driver-result.json';
          if (fs.existsSync(resultFile)) {
            const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
            const reportPath = result.report_path || '';
            const pdfPath = result.pdf_path || '';
            let msg = `✅ Research complete for **${topic}**.\n\nReport: \`${reportPath}\``;
            if (pdfPath) {
              msg += `\nPDF: \`${pdfPath}\``;
            }
            await mc.ctx.api.sendMessage(mc.chatIdNum, msg, { parse_mode: 'Markdown' });

            // Send PDF if available
            if (pdfPath && fs.existsSync(pdfPath)) {
              const { InputFile } = await import('grammy');
              await mc.ctx.api.sendDocument(mc.chatIdNum, new InputFile(pdfPath), {
                caption: `Research Report: ${topic}`,
              });
            }
          } else {
            await mc.ctx.api.sendMessage(mc.chatIdNum, `✅ Research complete for ${topic} but no result file found.`);
          }
        }
      } catch {
        // Status file may not exist yet
      }
    }, 30_000); // Check every 30 seconds

    // Safety timeout — stop polling after 60 minutes
    setTimeout(() => clearInterval(checkInterval), 60 * 60 * 1000);
  } catch (err) {
    logger.error({ err, topic }, 'Failed to launch research wrapper');
    await mc.ctx.reply(`Failed to launch research for ${topic}. Check logs.`);
  }

  return { handled: true };
}

// ── After-agent: process markers and send files/reactions ─────────────

async function processResponse(
  mc: MessageContext,
  result: { text: string | null },
): Promise<string | undefined> {
  if (!result.text) return undefined;

  const { text, files, reactions } = extractMarkers(result.text);

  // Reactions are handled automatically by bot.ts (👀 on receipt, ✅ on done).
  // REACT markers are still stripped from text above but not acted on here.

  // Send file attachments
  for (const file of files) {
    try {
      if (!fs.existsSync(file.filePath)) {
        await mc.ctx.api.sendMessage(mc.chatIdNum, `Could not send file: ${file.filePath} (not found)`);
        continue;
      }
      const { InputFile } = await import('grammy');
      const input = new InputFile(file.filePath);
      if (file.type === 'photo') {
        await mc.ctx.api.sendPhoto(mc.chatIdNum, input, file.caption ? { caption: file.caption } : undefined);
      } else {
        await mc.ctx.api.sendDocument(mc.chatIdNum, input, file.caption ? { caption: file.caption } : undefined);
      }
    } catch (err) {
      logger.error({ err, filePath: file.filePath }, 'Failed to send file');
      await mc.ctx.api.sendMessage(mc.chatIdNum, `Failed to send file: ${file.filePath}`);
    }
  }

  // Return cleaned text (markers stripped) — if only reactions and no text, return empty
  if (!text && (reactions.length > 0 || files.length > 0)) {
    return ''; // Signal: don't send a text message
  }

  // Strip emoji-only responses (bot handles reactions automatically via 👀/✅).
  // If Claude outputs just an emoji like "👍" with no real text, suppress it.
  const EMOJI_ONLY = /^\p{Emoji_Presentation}[\p{Emoji_Modifier}\p{Emoji_Component}\uFE0F]*$/u;
  if (text && EMOJI_ONLY.test(text.trim())) {
    return ''; // Don't send standalone emoji as text — reactions handle acknowledgment
  }

  return text || undefined;
}

// ── Abort recovery: salvage research results after timeout ────────────

const RESULT_FILE = '/tmp/research-driver-result.json';

async function recoverAfterAbort(
  _mc: Pick<import('../../../plugin-api.js').MessageContext, 'chatId' | 'chatIdNum'>,
): Promise<{ text: string; files?: Array<{ path: string; caption?: string }> } | undefined> {
  try {
    const raw = fs.readFileSync(RESULT_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as {
      status?: string; topic?: string; report_path?: string;
      pdf_path?: string; executive_summary?: string;
    };
    if (parsed.status !== 'complete' || !parsed.executive_summary) return undefined;

    const text = [
      '✅ Research completed (recovered after timeout)',
      '',
      `**Report:** \`${parsed.report_path}\``,
      '',
      parsed.executive_summary,
    ].join('\n');

    const files: Array<{ path: string; caption?: string }> = [];
    const filePath = parsed.pdf_path || parsed.report_path;
    if (filePath && fs.existsSync(filePath)) {
      files.push({ path: filePath, caption: `Research report: ${parsed.topic}` });
    }

    // Clean up
    try { fs.unlinkSync(RESULT_FILE); } catch { /* */ }

    return { text, files };
  } catch {
    return undefined;
  }
}

// ── Status provider: research progress details ────────────────────────

function getResearchStatus(): string[] {
  const lines: string[] = [];

  // Wrapper status
  try {
    const wrapperStatus = fs.readFileSync('/tmp/research-status.txt', 'utf-8').trim();
    if (wrapperStatus) lines.push(`📍 ${wrapperStatus}`);
  } catch { /* */ }

  // Trace log (last line from most recent advisor trace)
  try {
    const traceFiles = fs.readdirSync('/tmp').filter((f: string) => f.startsWith('ra-') && f.endsWith('-trace.log'));
    if (traceFiles.length > 0) {
      const latest = traceFiles.sort().pop()!;
      const content = fs.readFileSync(`/tmp/${latest}`, 'utf-8').trim();
      const lastLine = content.split('\n').pop() || '';
      if (lastLine) lines.push(`🔎 ${lastLine.slice(0, 120)}`);
    }
  } catch { /* */ }

  return lines;
}

// ── Plugin registration ───────────────────────────────────────────────

const plugin: ClawPlugin = {
  name: 'mkm-customizations',
  register(claw: ClawAPI) {
    // Before agent: intercept research requests
    claw.beforeAgent(handleResearchRequest);

    // After agent: extract markers, send files/reactions
    claw.afterAgent(processResponse);

    // Abort recovery: salvage research results after timeout
    claw.onAbortRecovery(recoverAfterAbort);

    // Status provider: research progress details for /status
    claw.statusProvider(getResearchStatus);
  },
};

export default plugin;
