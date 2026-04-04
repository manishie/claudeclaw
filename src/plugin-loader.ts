import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ClawAPI } from './plugin-api.js';
import { logger } from './logger.js';

import type { ClawPlugin } from './plugin-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Load plugins listed in plugins.json.
 *
 * Format: { "plugins": ["base/example", "custom/my-plugin"] }
 * Each entry resolves to dist/plugins/<entry>/index.js.
 * No plugins.json = no plugins loaded.
 */
export async function loadPlugins(): Promise<ClawAPI> {
  const api = new ClawAPI();

  const configPath = path.join(PROJECT_ROOT, 'plugins.json');
  if (!fs.existsSync(configPath)) {
    logger.info('No plugins.json found, running without plugins');
    return api;
  }

  let config: { plugins: string[] };
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    logger.error({ err }, 'Failed to parse plugins.json');
    return api;
  }

  if (!Array.isArray(config.plugins)) {
    logger.warn('plugins.json missing "plugins" array');
    return api;
  }

  for (const pluginPath of config.plugins) {
    try {
      const modulePath = path.join(__dirname, 'plugins', pluginPath, 'index.js');
      if (!fs.existsSync(modulePath)) {
        logger.warn({ pluginPath, modulePath }, 'Plugin not found, skipping');
        continue;
      }

      const mod = await import(modulePath) as { default?: ClawPlugin; plugin?: ClawPlugin };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin || typeof plugin.register !== 'function') {
        logger.warn({ pluginPath }, 'Plugin missing register() export, skipping');
        continue;
      }

      await plugin.register(api);
      logger.info({ name: plugin.name, path: pluginPath }, 'Plugin loaded');
    } catch (err) {
      logger.error({ err, pluginPath }, 'Failed to load plugin');
    }
  }

  return api;
}
