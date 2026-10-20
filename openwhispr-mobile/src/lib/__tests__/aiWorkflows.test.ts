import {
  cleanupRunsOnDevice,
  cloudCleanupNeedsAccount,
  unsetSelection,
  workflowSelection,
  workflowSummary,
} from '@/lib/aiWorkflows';
import type { UserConfig } from '@/types';

function config(overrides: Partial<UserConfig> = {}): UserConfig {
  return { defaultMode: 'private', ...overrides } as UserConfig;
}

describe('Note Chat with nothing saved', () => {
  it.each(['cloud', 'private', 'providers'] as const)('stays On-Device in %s mode', (mode) => {
    expect(unsetSelection('noteChat', mode)).toEqual({ mode: 'local' });
  });

  it('is summarized as On-Device in Local Mode', () => {
    expect(workflowSummary(config({}), 'noteChat', 'private')).toBe('On-Device');
  });

  it('leaves the voice assistant skipped under Bring Your Own Key', () => {
    expect(workflowSummary(config({}), 'agent', 'providers')).toBe('Not set');
  });
});

describe('workflowSummary for Text Cleanup', () => {
  // With nothing saved, Local Mode cleans on OpenWhispr Cloud for a signed-in account and on this
  // phone otherwise, since a separate Cloud pass needs a real account.
  it.each([
    ['account', 'On-Device'],
    ['session', 'On-Device'],
    ['none', 'On-Device'],
  ] as const)('with nothing saved in Local Mode and %s access, runs %s', (cloudAccess, label) => {
    expect(workflowSummary(config({}), 'cleanup', 'private', { cloudAccess })).toBe(label);
  });

  it('normalizes a legacy hosted cleanup even for a signed-in account', () => {
    const saved = config({ inference: { cleanup: { mode: 'openwhispr' } } });
    expect(workflowSummary(saved, 'cleanup', 'private', { cloudAccess: 'account' })).toBe(
      'On-Device',
    );
  });

  // Local Mode dictates on this phone, so Cloud cleanup is a separate pass that needs an account.
  it.each(['session', 'none'] as const)(
    'keeps a legacy hosted cleanup local with %s access',
    (cloudAccess) => {
      const saved = config({ inference: { cleanup: { mode: 'openwhispr' } } });
      expect(workflowSummary(saved, 'cleanup', 'private', { cloudAccess })).toBe('On-Device');
      expect(
        workflowSummary({ ...saved, defaultMode: 'cloud' }, 'cleanup', 'cloud', { cloudAccess }),
      ).toBe('On-Device');
    },
  );

  // A Cloud cleanup held automatically when dictation left Cloud isn't the user's own choice, so
  // where Local Mode can't run it there, it cleans on this phone like an unsaved one.
  it.each(['session', 'none'] as const)(
    'cleans on this phone for a Cloud cleanup held automatically, with %s access',
    (cloudAccess) => {
      const held = config({
        inference: { cleanup: { mode: 'openwhispr' } },
        pinnedInference: ['cleanup'],
      });
      expect(workflowSummary(held, 'cleanup', 'private', { cloudAccess })).toBe('On-Device');
      expect(cleanupRunsOnDevice(held, 'private', cloudAccess)).toBe(true);
      expect(cloudCleanupNeedsAccount(held, 'private', cloudAccess)).toBe(false);
      expect(workflowSelection(held, 'cleanup', 'cloud', cloudAccess)).toEqual({
        mode: 'local',
      });
    },
  );

  it('keeps a legacy hosted cleanup held automatically local for a signed-in account', () => {
    const held = config({
      inference: { cleanup: { mode: 'openwhispr' } },
      pinnedInference: ['cleanup'],
    });
    expect(workflowSummary(held, 'cleanup', 'private', { cloudAccess: 'account' })).toBe(
      'On-Device',
    );
    expect(cleanupRunsOnDevice(held, 'private', 'account')).toBe(true);
  });

  // Bring Your Own Key dictation also needs the separate Cloud pass, whether the user saved Cloud
  // or a dictation change held it there.
  it.each([
    ['saved', []],
    ['held automatically', ['cleanup']],
  ] as const)(
    'normalizes a %s hosted cleanup under Bring Your Own Key without an account',
    (_label, pins) => {
      const byok = config({
        defaultMode: 'providers',
        inference: { cleanup: { mode: 'openwhispr' } },
        pinnedInference: [...pins],
      });
      for (const cloudAccess of ['session', 'none'] as const) {
        expect(workflowSummary(byok, 'cleanup', 'providers', { cloudAccess })).toBe('On-Device');
      }
      expect(workflowSummary(byok, 'cleanup', 'providers', { cloudAccess: 'account' })).toBe(
        'On-Device',
      );
    },
  );

  it('is skipped in Local Mode when Apple Intelligence cannot run', () => {
    expect(
      workflowSummary(config({}), 'cleanup', 'private', {
        onDeviceUnavailable: 'Not supported on this iPhone',
      }),
    ).toBe('Skipped · Not supported on this iPhone');
  });

  it('names a cleanup provider saved in Local Mode', () => {
    const saved = config({
      inference: { cleanup: { mode: 'providers', providerId: 'openai', modelId: 'gpt-5-mini' } },
    });
    expect(workflowSummary(saved, 'cleanup', 'private')).toBe('OpenAI');
    expect(workflowSummary(saved, 'cleanup', 'private', { keyMissing: true })).toBe(
      'OpenAI · Key missing',
    );
  });

  it('runs On-Device in On-Device mode when saved as On-Device', () => {
    const saved = config({ inference: { cleanup: { mode: 'local' } } });
    expect(workflowSummary(saved, 'cleanup', 'private')).toBe('On-Device');
  });

  it.each(['private', 'cloud'] as const)(
    'says why saved On-Device cleanup is skipped in %s mode',
    (mode) => {
      const saved = config({ defaultMode: mode, inference: { cleanup: { mode: 'local' } } });
      expect(
        workflowSummary(saved, 'cleanup', mode, { onDeviceUnavailable: 'Apple Intelligence off' }),
      ).toBe('Skipped · Apple Intelligence off');
    },
  );

  it('ignores On-Device availability for a cleanup provider saved in Local Mode', () => {
    const saved = config({
      inference: { cleanup: { mode: 'providers', providerId: 'openai', modelId: 'gpt-5-mini' } },
    });
    expect(
      workflowSummary(saved, 'cleanup', 'private', {
        onDeviceUnavailable: 'Apple Intelligence off',
      }),
    ).toBe('OpenAI');
  });

  it('checks On-Device availability for a legacy hosted cleanup', () => {
    const saved = config({ defaultMode: 'cloud', inference: { cleanup: { mode: 'openwhispr' } } });
    expect(
      workflowSummary(saved, 'cleanup', 'cloud', { onDeviceUnavailable: 'Apple Intelligence off' }),
    ).toBe('Skipped · Apple Intelligence off');
  });

  it.each(['private', 'cloud', 'providers'] as const)(
    'is off in %s mode when Text Cleanup is turned off',
    (mode) => {
      const saved = config({
        defaultMode: mode,
        cleanupEnabled: false,
        inference: { cleanup: { mode: 'local' } },
      });
      expect(
        workflowSummary(saved, 'cleanup', mode, { onDeviceUnavailable: 'Apple Intelligence off' }),
      ).toBe('Off');
    },
  );

  it('still flags a provider cleanup whose key is missing', () => {
    const saved = config({
      defaultMode: 'providers',
      inference: { cleanup: { mode: 'providers', providerId: 'groq', modelId: 'llama' } },
    });
    expect(workflowSummary(saved, 'cleanup', 'providers', { keyMissing: true })).toBe(
      'Groq · Key missing',
    );
  });
});

describe('workflowSummary for Uploads', () => {
  // With nothing saved, Local Mode uploads to OpenWhispr Cloud whenever there is a session.
  it.each([
    ['account', 'On-Device'],
    ['session', 'On-Device'],
    ['none', 'On-Device'],
  ] as const)('with nothing saved in Local Mode and %s access, runs %s', (cloudAccess, label) => {
    expect(workflowSummary(config({}), 'upload', 'private', { cloudAccess })).toBe(label);
  });

  it('names an upload provider saved in Local Mode', () => {
    const saved = config({
      inference: { upload: { mode: 'providers', providerId: 'openai', modelId: 'whisper-1' } },
    });
    expect(workflowSummary(saved, 'upload', 'private')).toBe('OpenAI');
  });

  it('keeps dictation On-Device in Local Mode whatever is saved', () => {
    const saved = config({ inference: { dictation: { mode: 'openwhispr' } } });
    expect(workflowSummary(saved, 'dictation', 'private', { cloudAccess: 'account' })).toBe(
      'On-Device',
    );
  });
});

// A Cloud selection held when dictation left another mode runs as if unsaved in Local Mode, where
// the default already uses Cloud wherever the user's access lets it.
describe('workflowSelection in Local Mode for a Cloud hold', () => {
  const heldOnCloud = (scope: 'upload' | 'notes' | 'noteChat'): UserConfig =>
    config({ inference: { [scope]: { mode: 'openwhispr' } }, pinnedInference: [scope] });

  it.each([
    ['none', 'local'],
    ['session', 'local'],
    ['account', 'local'],
  ] as const)('runs an upload with %s access on %s', (cloudAccess, mode) => {
    expect(workflowSelection(heldOnCloud('upload'), 'upload', 'private', cloudAccess)).toEqual({
      mode,
    });
    expect(workflowSelection(heldOnCloud('upload'), 'upload', 'cloud', cloudAccess)).toEqual({
      mode: 'local',
    });
  });

  it('formats notes and chats on this phone', () => {
    expect(workflowSelection(heldOnCloud('notes'), 'notes', 'private', 'account')).toEqual({
      mode: 'local',
    });
    expect(workflowSelection(heldOnCloud('noteChat'), 'noteChat', 'private', 'none')).toEqual({
      mode: 'local',
    });
  });

  it('normalizes a legacy Cloud upload the user saved', () => {
    const saved = config({ inference: { upload: { mode: 'openwhispr' } } });
    expect(workflowSelection(saved, 'upload', 'private', 'none')).toEqual({ mode: 'local' });
  });
});

describe('workflowSummary for switched-off workflows', () => {
  const groq = { mode: 'providers' as const, providerId: 'groq', modelId: 'llama' };

  it('says Off for Note Chat and the Voice Assistant switched off, even with a key missing', () => {
    const saved = config({
      defaultMode: 'cloud',
      noteChatEnabled: false,
      dictationAgentEnabled: false,
      inference: { noteChat: groq, agent: groq },
    });
    expect(workflowSummary(saved, 'noteChat', 'cloud', { keyMissing: true })).toBe('Off');
    expect(workflowSummary(saved, 'agent', 'cloud', { keyMissing: true })).toBe('Off');
  });

  it('keeps Note Chat on when only the Voice Assistant is switched off', () => {
    const saved = config({ defaultMode: 'cloud', dictationAgentEnabled: false });
    expect(workflowSummary(saved, 'noteChat', 'cloud')).toBe('On-Device');
  });

  it('says the Voice Assistant is Off in Local Mode, which turns it off', () => {
    expect(workflowSummary(config({}), 'agent', 'private')).toBe('Off');
  });
});

// Stale official sessions cannot opt the new independent Note Chat workflow into hosted inference.
it.each(['none', 'session', 'account'] as const)(
  'keeps every unset Local Mode workflow local with %s access',
  (cloudAccess) => {
    for (const scope of ['dictation', 'upload', 'cleanup', 'notes', 'noteChat', 'agent'] as const) {
      expect(unsetSelection(scope, 'private', cloudAccess)).toEqual({ mode: 'local' });
    }
  },
);
