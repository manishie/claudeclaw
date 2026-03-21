import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ClawAPI } from './plugin-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLUGINS_JSON = path.join(PROJECT_ROOT, 'plugins.json');

// Back up and restore plugins.json around tests
let originalConfig: string | null = null;

beforeEach(() => {
  originalConfig = fs.existsSync(PLUGINS_JSON)
    ? fs.readFileSync(PLUGINS_JSON, 'utf-8')
    : null;
});

afterEach(() => {
  if (originalConfig !== null) {
    fs.writeFileSync(PLUGINS_JSON, originalConfig);
  } else if (fs.existsSync(PLUGINS_JSON)) {
    fs.unlinkSync(PLUGINS_JSON);
  }
});

describe('loadPlugins', () => {
  // Re-import for each test to avoid module cache issues
  async function callLoadPlugins() {
    const mod = await import('./plugin-loader.js');
    return mod.loadPlugins();
  }

  it('returns an empty ClawAPI when no plugins.json exists', async () => {
    if (fs.existsSync(PLUGINS_JSON)) fs.unlinkSync(PLUGINS_JSON);

    const api = await callLoadPlugins();

    expect(api).toBeInstanceOf(ClawAPI);
    expect(api._commands).toHaveLength(0);
    expect(api._beforeAgent).toHaveLength(0);
    expect(api._afterAgent).toHaveLength(0);
    expect(api._bootServices).toHaveLength(0);
    expect(api._intervals).toHaveLength(0);
    expect(api._shutdownHooks).toHaveLength(0);
  });

  it('returns an empty ClawAPI when plugins array is empty', async () => {
    fs.writeFileSync(PLUGINS_JSON, JSON.stringify({ plugins: [] }));

    const api = await callLoadPlugins();

    expect(api).toBeInstanceOf(ClawAPI);
    expect(api._commands).toHaveLength(0);
  });

  it('skips missing plugins gracefully', async () => {
    fs.writeFileSync(PLUGINS_JSON, JSON.stringify({ plugins: ['base/nonexistent'] }));

    const api = await callLoadPlugins();

    expect(api).toBeInstanceOf(ClawAPI);
    expect(api._commands).toHaveLength(0);
  });

  it('handles malformed plugins.json gracefully', async () => {
    fs.writeFileSync(PLUGINS_JSON, '{ not valid json!!!');

    const api = await callLoadPlugins();

    expect(api).toBeInstanceOf(ClawAPI);
    expect(api._commands).toHaveLength(0);
  });

  it('handles plugins.json without plugins array', async () => {
    fs.writeFileSync(PLUGINS_JSON, JSON.stringify({ something: 'else' }));

    const api = await callLoadPlugins();

    expect(api).toBeInstanceOf(ClawAPI);
    expect(api._commands).toHaveLength(0);
  });
});

describe('ClawAPI registration', () => {
  it('registers commands', () => {
    const api = new ClawAPI();
    const handler = vi.fn();

    api.command('test', 'A test command', handler);

    expect(api._commands).toHaveLength(1);
    expect(api._commands[0].name).toBe('test');
    expect(api._commands[0].description).toBe('A test command');
    expect(api._menuEntries).toHaveLength(1);
    expect(api._menuEntries[0].command).toBe('test');
  });

  it('registers beforeAgent hooks', () => {
    const api = new ClawAPI();
    const hook = vi.fn();

    api.beforeAgent(hook);

    expect(api._beforeAgent).toHaveLength(1);
    expect(api._beforeAgent[0]).toBe(hook);
  });

  it('registers afterAgent hooks', () => {
    const api = new ClawAPI();
    const hook = vi.fn();

    api.afterAgent(hook);

    expect(api._afterAgent).toHaveLength(1);
    expect(api._afterAgent[0]).toBe(hook);
  });

  it('registers boot services', () => {
    const api = new ClawAPI();
    const init = vi.fn();

    api.bootService('my-svc', init);

    expect(api._bootServices).toHaveLength(1);
    expect(api._bootServices[0].name).toBe('my-svc');
  });

  it('registers intervals', () => {
    const api = new ClawAPI();
    const fn = vi.fn();

    api.interval('heartbeat', fn, 5000);

    expect(api._intervals).toHaveLength(1);
    expect(api._intervals[0].name).toBe('heartbeat');
    expect(api._intervals[0].ms).toBe(5000);
  });

  it('registers shutdown hooks', () => {
    const api = new ClawAPI();
    const hook = vi.fn();

    api.onShutdown(hook);

    expect(api._shutdownHooks).toHaveLength(1);
    expect(api._shutdownHooks[0]).toBe(hook);
  });

  it('supports multiple registrations of same type', () => {
    const api = new ClawAPI();

    api.command('a', 'A', vi.fn());
    api.command('b', 'B', vi.fn());
    api.beforeAgent(vi.fn());
    api.beforeAgent(vi.fn());

    expect(api._commands).toHaveLength(2);
    expect(api._beforeAgent).toHaveLength(2);
  });
});
