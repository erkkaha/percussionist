// Phase handler: generating-builds → done

import type { PhaseHandler, Transition } from "../types.js";
import { getRun, readAllSessionsFromConfigMap, readPlanFromConfigMap } from "@percussionist/kube";
import { buildBuildTaskGeneratorRun, parseBuildTaskDefinitions } from "../../facilitator.js";
import { auxiliaryRunName } from "../../worker-builder.js";
import { buildTask } from "@percussionist/kube";
import type { Task } from "@percussionist/api";

export const handleGeneratingBuilds: PhaseHandler = async (ctx) => {
  const buildgenRunName = ctx.task.status?.worker?.buildTasksFacilitatorRun;
  
  if (!buildgenRunName) {
    // No buildgen run yet — create one.
    const newBuildgenRunName = auxiliaryRunName(
      ctx.project.metadata.name,
      "buildgen",
      ctx.task.metadata.name,
      "0",
    );

    // Fetch PLAN session summary.
    const planRunName = ctx.task.status?.worker?.runName;
    if (!planRunName) {
      // No worker run to read plan from — fail.
      return {
        targetPhase: "failed",
        sideEffects: [
          {
            type: "patchWorker",
            patch: {
              status: "Failed",
            },
          },
          {
            type: "emitEvent",
            event: { reason: "NoPlanRun", message: "No worker run to read plan from" },
          },
        ],
      };
    }

    try {
      // Try session snapshot ConfigMap first (correct signature: runName, namespace).
      let planSession = "";
      const sessionData = await readAllSessionsFromConfigMap(planRunName, ctx.namespace);
      if (sessionData && sessionData.allMessages.length > 0) {
        const lastN = sessionData.allMessages.slice(-10);
        planSession = lastN
          .map((m: unknown) => {
            const msg = m as { info?: { role?: string }; parts?: Array<{ type: string; text?: string }> };
            const role = msg.info?.role ?? "unknown";
            const text = (msg.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join(" ");
            return `[${role}] ${text || "(no text)"}`;
          })
          .join("\n\n");
      } else {
        // Session snapshot missing (pod/ConfigMap deleted) — fall back to plan artifact.
        console.log(
          `[generating-builds] ${ctx.task.metadata.name} session ConfigMap missing, falling back to plan artifact`,
        );
        const planContent = await readPlanFromConfigMap(
          ctx.project.metadata.name,
          ctx.task.metadata.name,
          ctx.namespace,
        );
        if (planContent) {
          planSession = `[Plan artifact]\n${planContent}`;
        }
        // If plan content is also absent, proceed with empty string — the
        // buildgen prompt has a "(none available)" fallback for that case.
      }

      const buildgenRun = await buildBuildTaskGeneratorRun(
        ctx.project,
        ctx.task,
        planRunName,
        newBuildgenRunName,
        planSession,
        undefined, // Use default facilitator agent
        ctx.allTasks,
      );

      return {
        targetPhase: "generating-builds",
        sideEffects: [
          {
            type: "createRun",
            run: buildgenRun,
          },
          {
            type: "patchWorker",
            patch: { buildTasksFacilitatorRun: newBuildgenRunName },
          },
        ],
      };
    } catch (e) {
      console.error(`[generating-builds] ${ctx.task.metadata.name} buildgen creation failed:`, e);
      // Failed to create buildgen — back to awaiting-human.
      return {
        targetPhase: "awaiting-human",
        sideEffects: [],
      };
    }
  }

  // Poll buildgen run.
  const buildgenRun = await getRun(buildgenRunName, ctx.namespace).catch(() => undefined);
  
  if (!buildgenRun || buildgenRun.status?.phase === "Failed") {
    // Buildgen failed — back to awaiting-human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [
        {
          type: "patchWorker",
          patch: { buildTasksFacilitatorRun: undefined },
        },
      ],
    };
  }

  if (buildgenRun.status?.phase !== "Succeeded") {
    return null; // Still running.
  }

  // Parse BUILD task definitions.
  try {
    const defs = await parseBuildTaskDefinitions(buildgenRunName, ctx.namespace);
    if (!defs || defs.length === 0) {
      // No BUILD tasks to create — done.
      return {
        targetPhase: "done",
        sideEffects: [
          {
            type: "patchWorker",
            patch: { buildTasksCreated: true },
          },
        ],
      };
    }

    // Create BUILD Task CRs.
    const taskSpecs: Task[] = defs.map((def, i) => {
      const suffix = String(i).padStart(2, "0");
      // K8s names must be ≤63 chars. Format: {project}-build-{plan}-{suffix}
      // Reserve 9 chars for "-build-XX" suffix, split remaining budget 50/50.
      const maxLen = 63;
      const reservedSuffix = 9; // "-build-" (7) + "XX" (2)
      const perNameBudget = Math.floor((maxLen - reservedSuffix) / 2);
      const projectSlug = ctx.project.metadata.name.slice(0, perNameBudget);
      const planSlug = ctx.task.metadata.name.slice(0, perNameBudget);
      const taskName = `${projectSlug}-build-${planSlug}-${suffix}`;
      
      // Determine predecessor: if predecessorIndex is set, use that task; otherwise previous task in sequence.
      let predecessorRef: string | undefined;
      if (def.predecessorIndex !== null && def.predecessorIndex !== undefined && def.predecessorIndex >= 0) {
        const predDef = defs[def.predecessorIndex];
        if (predDef) {
          const predSuffix = String(def.predecessorIndex).padStart(2, "0");
          const predTaskName = `${projectSlug}-build-${planSlug}-${predSuffix}`;
          predecessorRef = predTaskName;
        }
      } else if (i > 0) {
        // Default: previous task in sequence.
        const predSuffix = String(i - 1).padStart(2, "0");
        const predTaskName = `${projectSlug}-build-${planSlug}-${predSuffix}`;
        predecessorRef = predTaskName;
      }
      
      return buildTask({
        name: taskName,
        projectName: ctx.project.metadata.name,
        projectUid: ctx.project.metadata.uid!,
        ns: ctx.namespace,
        spec: {
          projectRef: ctx.project.metadata.name,
          type: "BUILD",
          title: def.title,
          description: def.description,
          agent: def.agent ?? ctx.project.spec.agent ?? "builder",
          priority: def.priority ?? "medium",
          parentTaskRef: ctx.task.metadata.name,
          predecessorRef,
        },
      });
    });

    const taskNames = taskSpecs.map((t) => t.metadata.name);

    return {
      targetPhase: "done",
      sideEffects: [
        {
          type: "createTasks",
          tasks: taskSpecs,
        },
        {
          type: "patchWorker",
          patch: {
            buildTasksCreated: true,
            createdBuildTaskRefs: taskNames,
          },
        },
      ],
    };
  } catch (e) {
    console.error(`[generating-builds] ${ctx.task.metadata.name} parse failed:`, e);
    // Parse failed — back to awaiting-human.
    return {
      targetPhase: "awaiting-human",
      sideEffects: [
        {
          type: "patchWorker",
          patch: { buildTasksFacilitatorRun: undefined },
        },
      ],
    };
  }
};
