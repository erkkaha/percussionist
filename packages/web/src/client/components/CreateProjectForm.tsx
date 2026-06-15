import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchAgents, submitProject, updateProject } from '../lib/api';
import type { CreateProjectRequest, ProjectDetail } from '../lib/types';
import AdvancedTab from './project-form/AdvancedTab';
import ExecutionTab from './project-form/ExecutionTab';
// Tab components
import GeneralTab from './project-form/GeneralTab';
import MemoriesTab from './project-form/MemoriesTab';
import SourceAuthTab from './project-form/SourceAuthTab';
// Hook + helpers
import { buildProjectRequest, useProjectForm } from './project-form/useProjectForm';
import WorkspaceServicesTab from './project-form/WorkspaceServicesTab';

// Tabs UI component
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

// ---------------------------------------------------------------------------
// Tab definitions (ordered list)
// ---------------------------------------------------------------------------

type ProjectTabId =
  | 'general'
  | 'source-auth'
  | 'execution'
  | 'workspace-services'
  | 'memories'
  | 'advanced';

const TABS: Array<{ id: ProjectTabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'source-auth', label: 'Source & Auth' },
  { id: 'execution', label: 'Execution' },
  { id: 'workspace-services', label: 'Workspace & Services' },
  { id: 'memories', label: 'Memories' },
  { id: 'advanced', label: 'Advanced' },
];

const DEFAULT_TAB = TABS.at(0)?.id ?? 'general';

function resolveTab(searchParams: URLSearchParams, hash: string): ProjectTabId {
  // Priority: query param > hash > default
  const qp = searchParams.get('tab');
  if (qp && TABS.some((t) => t.id === qp)) return qp as ProjectTabId;
  if (hash.startsWith('#')) {
    const h = hash.slice(1);
    if (TABS.some((t) => t.id === h)) return h as ProjectTabId;
  }
  return DEFAULT_TAB;
}

// ---------------------------------------------------------------------------
// Main form component
// ---------------------------------------------------------------------------

type CreateProjectFormProps = {
  mode?: 'create' | 'edit';
  initialProject?: ProjectDetail;
};

export default function CreateProjectForm({
  mode = 'create',
  initialProject,
}: CreateProjectFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = mode === 'edit';
  const [searchParams, setSearchParams] = useSearchParams();

  // Tab state — synced with URL (query param + hash fallback)
  const [activeTab, setActiveTab] = useState<ProjectTabId>(() => {
    try {
      return resolveTab(searchParams, window.location.hash ?? '');
    } catch {
      return DEFAULT_TAB;
    }
  });

  // Sync tab changes to URL without polluting history
  useEffect(() => {
    setSearchParams({ tab: activeTab }, { replace: true });
    // Also update hash for deep-link compatibility (e.g. from bookmarks)
    if (window.location.hash !== `#${activeTab}`) {
      window.history.replaceState(null, '', `#${activeTab}`);
    }
  }, [activeTab, setSearchParams]);

  const initialSpec = initialProject?.spec;
  const form = useProjectForm(initialSpec, initialProject);

  // Fetch available agents for roster picker (needed by AdvancedTab)
  const { data: clusterAgents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
  });

  const mutation = useMutation({
    mutationFn: (req: CreateProjectRequest) => {
      if (isEdit && initialProject) {
        return updateProject(initialProject.metadata.name, req);
      }
      return submitProject(req);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate('/settings?tab=projects');
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.configJsonError) return;
    if (form.hasSidecarErrors) return;
    if (form.hasInjectFileErrors) return;
    const req = buildProjectRequest(form, isEdit);
    mutation.mutate(req);
  }

  // Shared input classes — kept for backward compat with any remaining inline patterns
  const inputClass =
    'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-accent/60 focus:outline-none';
  const _monoInputClass = `${inputClass} font-mono`;

  // Build the props for each tab (typed slices of form state)
  const generalProps = {
    isEdit,
    form: {
      name: form.name,
      displayName: form.displayName,
      model: form.model,
      agent: form.agent,
      maxParallel: form.maxParallel,
      timeoutSeconds: form.timeoutSeconds,
      featureBranchingEnabled: form.featureBranchingEnabled,
      phase: form.phase,
      setName: form.setName,
      setDisplayName: form.setDisplayName,
      setModel: form.setModel,
      setAgent: form.setAgent,
      setMaxParallel: form.setMaxParallel,
      setTimeoutSeconds: form.setTimeoutSeconds,
      setFeatureBranchingEnabled: form.setFeatureBranchingEnabled,
      setPhase: form.setPhase,
    },
  };

  const sourceAuthProps = {
    form: {
      gitUrl: form.gitUrl,
      gitRef: form.gitRef,
      gitSshSecret: form.gitSshSecret,
      gitGithubTokenSecret: form.gitGithubTokenSecret,
      gitAuthorName: form.gitAuthorName,
      gitAuthorEmail: form.gitAuthorEmail,
      sourceLocal: form.sourceLocal,
      llmKeysSecret: form.llmKeysSecret,
      authSecret: form.authSecret,
      opencodeConfig: form.opencodeConfig,
      configJsonError: form.configJsonError,
      setGitUrl: form.setGitUrl,
      setGitRef: form.setGitRef,
      setGitSshSecret: form.setGitSshSecret,
      setGitGithubTokenSecret: form.setGitGithubTokenSecret,
      setGitAuthorName: form.setGitAuthorName,
      setGitAuthorEmail: form.setGitAuthorEmail,
      setSourceLocal: form.setSourceLocal,
      setLlmKeysSecret: form.setLlmKeysSecret,
      setAuthSecret: form.setAuthSecret,
      setOpencodeConfig: form.setOpencodeConfig,
    },
  };

  const executionProps = {
    form: {
      retryPolicyEnabled: form.retryPolicyEnabled,
      retryPolicyMaxAttempts: form.retryPolicyMaxAttempts,
      retryPolicyBackoffSeconds: form.retryPolicyBackoffSeconds,
      retryPolicyBackoffMultiplier: form.retryPolicyBackoffMultiplier,
      retryPolicyMaxBackoffSeconds: form.retryPolicyMaxBackoffSeconds,
      retryPolicyPoisonPillThreshold: form.retryPolicyPoisonPillThreshold,
      reviewPolicyAiReviewerEnabled: form.reviewPolicyAiReviewerEnabled,
      reviewPolicyAiReviewerAgent: form.reviewPolicyAiReviewerAgent,
      reviewPolicyMaxAutoReworks: form.reviewPolicyMaxAutoReworks,
      runnerImage: form.runnerImage,
      runnerPackages: form.runnerPackages,
      cpuRequest: form.cpuRequest,
      memRequest: form.memRequest,
      cpuLimit: form.cpuLimit,
      memLimit: form.memLimit,
      worktreeReuse: form.worktreeReuse,
      flowPreset: form.flowPreset,
      flowHumanApprovalPlan: form.flowHumanApprovalPlan,
      flowHumanApprovalBuild: form.flowHumanApprovalBuild,
      flowPlanOnApprove: form.flowPlanOnApprove,
      flowBuildOnSuccess: form.flowBuildOnSuccess,
      flowBuildOnApprove: form.flowBuildOnApprove,
      flowMergeMode: form.flowMergeMode,
      setRetryPolicyEnabled: form.setRetryPolicyEnabled,
      setRetryPolicyMaxAttempts: form.setRetryPolicyMaxAttempts,
      setRetryPolicyBackoffSeconds: form.setRetryPolicyBackoffSeconds,
      setRetryPolicyBackoffMultiplier: form.setRetryPolicyBackoffMultiplier,
      setRetryPolicyMaxBackoffSeconds: form.setRetryPolicyMaxBackoffSeconds,
      setRetryPolicyPoisonPillThreshold: form.setRetryPolicyPoisonPillThreshold,
      setReviewPolicyAiReviewerEnabled: form.setReviewPolicyAiReviewerEnabled,
      setReviewPolicyAiReviewerAgent: form.setReviewPolicyAiReviewerAgent,
      setReviewPolicyMaxAutoReworks: form.setReviewPolicyMaxAutoReworks,
      setRunnerImage: form.setRunnerImage,
      setRunnerPackages: form.setRunnerPackages,
      setCpuRequest: form.setCpuRequest,
      setMemRequest: form.setMemRequest,
      setCpuLimit: form.setCpuLimit,
      setMemLimit: form.setMemLimit,
      setWorktreeReuse: form.setWorktreeReuse,
      setFlowPreset: form.setFlowPreset,
      setFlowHumanApprovalPlan: form.setFlowHumanApprovalPlan,
      setFlowHumanApprovalBuild: form.setFlowHumanApprovalBuild,
      setFlowPlanOnApprove: form.setFlowPlanOnApprove,
      setFlowBuildOnSuccess: form.setFlowBuildOnSuccess,
      setFlowBuildOnApprove: form.setFlowBuildOnApprove,
      setFlowMergeMode: form.setFlowMergeMode,
    },
  };

  const workspaceServicesProps = {
    form: {
      codeServerEnabled: form.codeServerEnabled,
      codeServerImage: form.codeServerImage,
      csCpuRequest: form.csCpuRequest,
      csMemRequest: form.csMemRequest,
      csCpuLimit: form.csCpuLimit,
      csMemLimit: form.csMemLimit,
      pvcName: form.pvcName,
      mountPath: form.mountPath,
      storageClass: form.storageClass,
      embeddingEnabled: form.embeddingEnabled,
      embeddingModel: form.embeddingModel,
      embeddingDimensions: form.embeddingDimensions,
      embeddingOllamaUrl: form.embeddingOllamaUrl,
      execImage: form.execImage,
      setCodeServerEnabled: form.setCodeServerEnabled,
      setCodeServerImage: form.setCodeServerImage,
      setCSCpuRequest: form.setCSCpuRequest,
      setCSMemRequest: form.setCSMemRequest,
      setCSCpuLimit: form.setCSCpuLimit,
      setCSMemLimit: form.setCSMemLimit,
      setPvcName: form.setPvcName,
      setMountPath: form.setMountPath,
      setStorageClass: form.setStorageClass,
      setEmbeddingEnabled: form.setEmbeddingEnabled,
      setEmbeddingModel: form.setEmbeddingModel,
      setEmbeddingDimensions: form.setEmbeddingDimensions,
      setEmbeddingOllamaUrl: form.setEmbeddingOllamaUrl,
      setExecImage: form.setExecImage,
    },
  };

  const advancedProps = {
    form: {
      sidecars: form.sidecars,
      injectFiles: form.injectFiles,
      initScript: form.initScript,
      rosterAgents: form.rosterAgents,
      rosterPickerValue: form.rosterPickerValue,
      sidecarErrors: form.sidecarErrors,
      hasSidecarErrors: form.hasSidecarErrors,
      injectFileErrors: form.injectFileErrors,
      hasInjectFileErrors: form.hasInjectFileErrors,
      setSidecars: form.setSidecars,
      setInjectFiles: form.setInjectFiles,
      setInitScript: form.setInitScript,
      setRosterAgents: form.setRosterAgents,
      setRosterPickerValue: form.setRosterPickerValue,
      addSidecar: form.addSidecar,
      removeSidecar: form.removeSidecar,
      updateSidecar: form.updateSidecar,
      addInjectFile: form.addInjectFile,
      removeInjectFile: form.removeInjectFile,
      updateInjectFile: form.updateInjectFile,
    },
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <Link
        to="/settings?tab=projects"
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
      >
        <span>&larr;</span> All projects
      </Link>

      <div>
        <h1 className="text-headline-lg">{isEdit ? 'Edit Project' : 'New Project'}</h1>
        <p className="text-caption-xs text-text-muted mt-1">
          {isEdit
            ? 'Update reusable defaults for this project.'
            : 'Save reusable defaults — git URL, secrets, model — under a short name. Pick this project when creating a run to pre-fill those fields.'}
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Tab navigation */}
        {/* Layout uses `overflow-x-hidden` on the main content, so local scroll */}
        {/* containers are required for any horizontal tab bar on mobile. */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ProjectTabId)}>
          <div className="w-full touch-scroll-x">
            <TabsList className="mb-4 w-max min-w-max">
              {TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id} className="shrink-0">
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* General tab */}
          <TabsContent value="general" className="space-y-5">
            <GeneralTab form={generalProps.form} isEdit={generalProps.isEdit} />
          </TabsContent>

          {/* Source & Auth tab */}
          <TabsContent value="source-auth" className="space-y-5">
            <SourceAuthTab form={sourceAuthProps.form} />
          </TabsContent>

          {/* Execution tab */}
          <TabsContent value="execution" className="space-y-5">
            <ExecutionTab form={executionProps.form} />
          </TabsContent>

          {/* Workspace & Services tab */}
          <TabsContent value="workspace-services" className="space-y-5">
            <WorkspaceServicesTab form={workspaceServicesProps.form} />
          </TabsContent>

          {/* Memories tab */}
          <TabsContent value="memories" className="space-y-5">
            <MemoriesTab isEdit={isEdit} projectName={initialProject?.metadata.name} />
          </TabsContent>

          {/* Advanced tab */}
          <TabsContent value="advanced" className="space-y-5">
            <AdvancedTab form={advancedProps.form} clusterAgents={clusterAgents} />
          </TabsContent>
        </Tabs>

        {/* Error banner (visible regardless of active tab) */}
        {mutation.error && (
          <div className="mt-4 rounded-md border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container">
            {mutation.error.message}
          </div>
        )}

        {/* Submit bar */}
        <div className="flex items-center gap-3 pt-4 mt-2 border-t border-border">
          <button
            type="submit"
            disabled={
              (!isEdit && !form.name.trim()) ||
              mutation.isPending ||
              form.gitAuthorIncomplete ||
              !!form.configJsonError ||
              form.hasSidecarErrors ||
              form.hasInjectFileErrors
            }
            className="rounded-md bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-text transition-colors"
          >
            {mutation.isPending
              ? isEdit
                ? 'Saving…'
                : 'Creating…'
              : isEdit
                ? 'Save Changes'
                : 'Create Project'}
          </button>
          <Link
            to="/settings?tab=projects"
            className="text-sm text-text-muted hover:text-text transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
