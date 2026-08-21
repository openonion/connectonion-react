import fixture from './fixtures/oip/mode-contract-v1.json';
import {
  DEFAULT_MODE,
  MODES,
  normalizeSessionState,
  validatedModeState,
} from '../src/connect/mode';
import { hostSessionModeState } from '../src/connect/wire-events';

describe('ConnectOnion 1.7 mode contract', () => {
  test('consumes the shared public vocabulary byte for byte', () => {
    expect(DEFAULT_MODE).toBe(fixture.defaultMode);
    expect(MODES).toEqual(fixture.modes.map((mode) => mode.id));
  });

  test.each(fixture.validStates)('keeps valid state %#', (entry) => {
    const normalized = normalizeSessionState(entry.input);
    expect(normalized?.mode).toBe(entry.mode);
    expect(normalized?.turns_left ?? null).toBe(entry.turnsLeft);
  });

  test.each(fixture.discardToAuto)('discards unknown authority %#', (input) => {
    expect(normalizeSessionState(input)).toEqual({ mode: 'auto' });
  });

  test('accepts only internally consistent Host advertisements', () => {
    expect(hostSessionModeState({
      session_modes: {
        currentModeId: 'full-access',
        turnsLeft: 3,
        availableModes: fixture.modes.map(({ id, name }) => ({ id, name })),
      },
    })).toEqual({
      currentModeId: 'full-access',
      turnsLeft: 3,
      availableModes: fixture.modes.map(({ id, name }) => ({ id, name })),
    });

    expect(hostSessionModeState({
      session_modes: {
        currentModeId: 'full-access',
        turnsLeft: null,
        availableModes: [{ id: 'full-access', name: 'Full access' }],
      },
    })).toBeNull();
  });

  test('ordinary modes reject a Full access countdown', () => {
    expect(validatedModeState('auto', 2)).toBeNull();
  });
});
