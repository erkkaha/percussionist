// Phase handler: waiting-for-input → running

import type { PhaseHandler, Transition } from "../types.js";

export const handleWaitingForInput: PhaseHandler = async (ctx) => {
  // Answer stored as task annotation by UI action endpoint.
  const answerKey = `percussionist.dev/answer-${ctx.task.metadata.name}`;
  const answer = ctx.task.metadata.annotations?.[answerKey];
  
  if (!answer) {
    return null; // Still waiting for human answer.
  }

  // Dispatcher polls this annotation and injects into agent session.
  // Once injected, run transitions back to Running phase.
  if (ctx.run?.status?.phase === "Running") {
    return {
      targetPhase: "running",
      sideEffects: [
        {
          type: "clearTaskAnnotations",
          keys: [answerKey],
        },
      ],
    };
  }

  return null; // Answer set but run hasn't resumed yet.
};
