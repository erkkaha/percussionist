import ModelSelector from '../ModelSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { ProjectFormHookReturn } from './useProjectForm';

interface AgentsTabProps {
  form: Pick<
    ProjectFormHookReturn,
    | 'rosterAgents'
    | 'rosterPickerValue'
    | 'setRosterPickerValue'
    | 'setRosterAgents'
    | 'addRosterAgent'
    | 'updateRosterAgentModel'
  >;
  clusterAgents: Array<{ name: string; content: string; model?: string }>;
}

export default function AgentsTab({ form, clusterAgents }: AgentsTabProps) {
  function clusterAgentModel(name: string): string | undefined {
    return clusterAgents.find((a) => a.name === name)?.model;
  }

  return (
    <div className="space-y-5">
      {/* Agent roster */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium text-text-muted">Agent roster</legend>
        <p className="text-xs text-text-dim">
          ClusterAgents available to tasks in this project. Tasks must reference an agent from this
          list. Leave the model empty to fall back to the ClusterAgent's configured model (if set),
          then the project default model. Selecting a model overrides those defaults for this agent.
        </p>

        {form.rosterAgents.length > 0 && (
          <div className="space-y-3">
            {form.rosterAgents.map((row) => {
              const fallback = clusterAgentModel(row.name);
              return (
                <div
                  key={row.name}
                  className="rounded-md border border-border bg-surface-raised p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-sm text-text truncate">{row.name}</span>
                    <button
                      type="button"
                      onClick={() =>
                        form.setRosterAgents((prev) => prev.filter((r) => r.name !== row.name))
                      }
                      className="text-xs text-text-dim hover:text-phase-failed transition-colors"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-muted">Model</label>
                    <ModelSelector
                      value={row.model}
                      onChange={(m) => form.updateRosterAgentModel(row.name, m)}
                      placeholder="default — ClusterAgent / project model"
                    />
                    {row.model.trim() === '' && (
                      <p className="text-xs text-text-dim">
                        default
                        {fallback ? (
                          <>
                            {' '}
                            — ClusterAgent model <code className="font-mono">{fallback}</code>
                          </>
                        ) : (
                          ' — falls back to the ClusterAgent model (if set) or the project default'
                        )}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Select
            value={form.rosterPickerValue}
            onValueChange={(v) => {
              if (v && !form.rosterAgents.some((r) => r.name === v)) {
                form.addRosterAgent(v);
              }
              form.setRosterPickerValue('');
            }}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="— add agent —" />
            </SelectTrigger>
            <SelectContent>
              {clusterAgents
                .filter((a) => !form.rosterAgents.some((r) => r.name === a.name))
                .map((a) => (
                  <SelectItem key={a.name} value={a.name}>
                    {a.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </fieldset>
    </div>
  );
}
