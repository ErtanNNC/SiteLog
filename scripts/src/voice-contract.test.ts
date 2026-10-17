import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOICE_CONTRACT, VOICE_KEYS, type VoiceRoute } from '@sitelog/shared';
import { voiceContractDrift, voiceContractFiles, writeVoiceContract } from './voice-contract.ts';

/**
 * W3-01: `pnpm voice:contract` is deterministic, idempotent, and the checked-in
 * `apps/voice-agent/contract/` and `copy/` match it (the same check as `-- --check` in CI).
 */
describe('pnpm voice:contract', () => {
  it('generates the same files every time', () => {
    const a = voiceContractFiles();
    const b = voiceContractFiles();
    expect([...a]).toEqual([...b]);
    // The schemas, index.json, the three languages, spoken.json (W4-07) and legal.json (W4-06).
    expect(a.size).toBe(Object.keys(VOICE_CONTRACT).length + 1 + 3 + 1 + 1);
    expect(a.has('apps/voice-agent/copy/legal.json')).toBe(true);
    for (const content of a.values()) {
      expect(content.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(content)).not.toThrow();
    }
  });

  it('writes every route, schema and line the agent needs', () => {
    const files = voiceContractFiles();
    const index = JSON.parse(files.get('apps/voice-agent/contract/index.json')!) as {
      routes: Record<string, VoiceRoute>;
      callTokenHeader: string;
    };
    expect(index.callTokenHeader).toBe('X-Call-Token');
    for (const route of Object.values(index.routes)) {
      expect(files.has(`apps/voice-agent/contract/${route.request}.json`), route.path).toBe(true);
      expect(files.has(`apps/voice-agent/contract/${route.response}.json`), route.path).toBe(true);
    }
    expect(index.routes.calls_start!.path).toBe('/voice/calls/start');
    for (const language of ['en', 'es', 'tr']) {
      const copy = JSON.parse(files.get(`apps/voice-agent/copy/${language}.json`)!) as {
        lines: Record<string, string>;
      };
      expect(Object.keys(copy.lines)).toEqual([...VOICE_KEYS]);
    }
  });

  it('matches the checked-in files', () => {
    expect(voiceContractDrift()).toEqual([]);
  });

  it('is idempotent and reports missing, changed and left-over files', () => {
    const root = mkdtempSync(join(tmpdir(), 'voice-contract-'));
    expect(voiceContractDrift(root).every((p) => p.startsWith('missing: '))).toBe(true);
    expect(writeVoiceContract(root).length).toBe(voiceContractFiles().size);
    expect(writeVoiceContract(root)).toEqual([]);
    expect(voiceContractDrift(root)).toEqual([]);
    writeFileSync(join(root, 'apps/voice-agent/copy/en.json'), '{}\n');
    writeFileSync(join(root, 'apps/voice-agent/contract/old_tool.json'), '{}\n');
    expect(voiceContractDrift(root).sort()).toEqual([
      'differs: apps/voice-agent/copy/en.json',
      'left over: apps/voice-agent/contract/old_tool.json',
    ]);
    writeVoiceContract(root);
    expect(voiceContractDrift(root)).toEqual([]);
  });
});
