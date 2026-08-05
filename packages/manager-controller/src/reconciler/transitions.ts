// Transition table — single source of truth for allowed phase transitions.
// Hoisted to @percussionist/api so the CLI can validate against the same table
// the manager's reconciler uses; this file is a re-export shim so existing
// imports (decision.ts, effects.ts, agent/tools.ts, tests) keep working unchanged.

export { isValidTransition, TRANSITION_TABLE, validateTransition } from '@percussionist/api';
