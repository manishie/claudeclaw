import type { Api, Context, RawApi } from 'grammy';

/** Context passed to message pipeline hooks. */
export interface MessageContext {
  chatId: string;
  chatIdNum: number;
  message: string;
  ctx: Context;
  sessionId: string | undefined;
}

/**
 * Runs before the agent. Return values:
 * - `undefined` -- no change, continue pipeline
 * - `string` -- replace the message text sent to Claude
 * - `{ handled: true }` -- short-circuit, skip Claude entirely
 */
export type BeforeAgentHook = (
  mc: MessageContext,
) => Promise<string | { handled: true } | undefined>;

/**
 * Runs after the agent, before sending to Telegram.
 * Return a string to replace the response text, or undefined to leave it.
 */
export type AfterAgentHook = (
  mc: MessageContext,
  result: { text: string | null },
) => Promise<string | undefined>;

export type ShutdownHook = () => Promise<void> | void;

/** A plugin module must export this shape (as default or named `plugin`). */
export interface ClawPlugin {
  name: string;
  register: (claw: ClawAPI) => void | Promise<void>;
}

/** Registration API passed to each plugin's `register()` function. */
export class ClawAPI {
  /** @internal */ readonly _commands: Array<{
    name: string;
    description: string;
    handler: (ctx: Context) => Promise<void> | void;
  }> = [];

  /** @internal */ readonly _beforeAgent: BeforeAgentHook[] = [];
  /** @internal */ readonly _afterAgent: AfterAgentHook[] = [];

  /** @internal */ readonly _bootServices: Array<{
    name: string;
    init: (botApi: Api<RawApi>) => Promise<void> | void;
  }> = [];

  /** @internal */ readonly _intervals: Array<{
    name: string;
    fn: () => Promise<void> | void;
    ms: number;
  }> = [];

  /** @internal */ readonly _shutdownHooks: ShutdownHook[] = [];
  /** @internal */ readonly _menuEntries: Array<{ command: string; description: string }> = [];

  /** Register a /command with a Telegram menu entry. */
  command(
    name: string,
    description: string,
    handler: (ctx: Context) => Promise<void> | void,
  ): void {
    this._commands.push({ name, description, handler });
    this._menuEntries.push({ command: name, description });
  }

  /** Hook that runs before the agent. Can modify the message or short-circuit. */
  beforeAgent(hook: BeforeAgentHook): void {
    this._beforeAgent.push(hook);
  }

  /** Hook that runs after the agent, before sending to Telegram. Can modify response text. */
  afterAgent(hook: AfterAgentHook): void {
    this._afterAgent.push(hook);
  }

  /** Register a service that starts at boot time. */
  bootService(name: string, init: (botApi: Api<RawApi>) => Promise<void> | void): void {
    this._bootServices.push({ name, init });
  }

  /** Register a periodic task. */
  interval(name: string, fn: () => Promise<void> | void, ms: number): void {
    this._intervals.push({ name, fn, ms });
  }

  /** Register a shutdown hook. */
  onShutdown(hook: ShutdownHook): void {
    this._shutdownHooks.push(hook);
  }
}
