import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOpenClawConfig } from '../src/gateway.js';

describe('sanitizeOpenClawConfig', () => {
  it('migrates discord.streaming boolean true to object', () => {
    const config = { channels: { discord: { streaming: true } } };
    sanitizeOpenClawConfig(config);
    assert.deepEqual(config.channels.discord.streaming, { mode: 'progress' });
  });

  it('migrates discord.streaming boolean false to off', () => {
    const config = { channels: { discord: { streaming: false } } };
    sanitizeOpenClawConfig(config);
    assert.deepEqual(config.channels.discord.streaming, { mode: 'off' });
  });

  it('migrates legacy streamMode string to streaming object', () => {
    const config = { channels: { discord: { streamMode: 'partial' } } };
    sanitizeOpenClawConfig(config);
    assert.deepEqual(config.channels.discord.streaming, { mode: 'partial' });
    assert.equal(config.channels.discord.streamMode, undefined);
  });

  it('sets model.name from model.id when missing', () => {
    const config = {
      models: {
        providers: {
          custom: {
            models: [{ id: 'gpt-4o', contextWindow: 200000 }]
          }
        }
      }
    };
    sanitizeOpenClawConfig(config);
    assert.equal(config.models.providers.custom.models[0].name, 'gpt-4o');
  });

  it('raises low contextWindow to 200000', () => {
    const config = {
      models: {
        providers: {
          custom: {
            models: [{ id: 'm', name: 'm', contextWindow: 4096 }]
          }
        }
      }
    };
    sanitizeOpenClawConfig(config);
    assert.equal(config.models.providers.custom.models[0].contextWindow, 200000);
  });
});
