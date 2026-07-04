import {
  ORCHESTRATION_EVENT_TYPES,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_EVENT_CHANNEL,
} from './protocol';

/**
 * Protocol parity guard. The frontend mirror
 * (devflow-frontend/src/shared/api/orchestration-events.ts) pins the SAME
 * literal list in its own test. If you change the protocol, update BOTH files
 * and BOTH tests — a mismatch here is the signal that the mirror drifted.
 */
describe('orchestration protocol', () => {
  it('pins the canonical event type list', () => {
    expect([...ORCHESTRATION_EVENT_TYPES]).toEqual([
      'run.status',
      'node.lifecycle',
      'node.progress',
      'node.telemetry',
      'agent.stream',
      'run.error',
    ]);
  });

  it('pins the protocol version and channel name', () => {
    expect(ORCHESTRATION_PROTOCOL_VERSION).toBe(1);
    expect(ORCHESTRATION_EVENT_CHANNEL).toBe('orchestration:event');
  });
});
