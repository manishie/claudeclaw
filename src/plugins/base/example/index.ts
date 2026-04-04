/**
 * Example plugin demonstrating the ClaudeClaw plugin API.
 *
 * Enable by adding "base/example" to plugins.json:
 *   { "plugins": ["base/example"] }
 */
import type { ClawPlugin } from '../../../plugin-api.js';
import { logger } from '../../../logger.js';

const plugin: ClawPlugin = {
  name: 'example',

  register(claw) {
    // Register a /ping command
    claw.command('ping', 'Check if bot is alive', async (ctx) => {
      await ctx.reply('pong');
    });

    // beforeAgent hook: intercept messages before they reach Claude.
    // Return { handled: true } to skip Claude, a string to modify the
    // message, or undefined to pass through unchanged.
    claw.beforeAgent(async (mc) => {
      if (mc.message.toLowerCase().trim() === 'marco') {
        await mc.ctx.reply('polo');
        return { handled: true };
      }
      return undefined;
    });

    // Boot service: runs once at startup with access to the Telegram API
    claw.bootService('example-boot', (_botApi) => {
      logger.info('Example plugin booted');
    });

    // Periodic task: runs on a fixed interval
    claw.interval('example-heartbeat', () => {
      logger.debug('Example plugin heartbeat');
    }, 60_000);

    // Shutdown hook: cleanup on exit
    claw.onShutdown(() => {
      logger.info('Example plugin shutting down');
    });
  },
};

export default plugin;
