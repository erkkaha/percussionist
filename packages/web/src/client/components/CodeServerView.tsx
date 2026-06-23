import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { fetchProject } from '../lib/api';

export default function CodeServerView() {
  const { name } = useParams<{ name: string }>();
  const [searchParams] = useSearchParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ['project', name],
    queryFn: () => fetchProject(name!),
    enabled: !!name,
  });

  if (!name) {
    return <p className="text-text-dim p-4">No project specified.</p>;
  }

  if (isLoading) {
    return <p className="text-text-dim p-4">Loading code-server...</p>;
  }

  if (error) {
    return (
      <p className="text-phase-failed p-4">Failed to load project: {(error as Error).message}</p>
    );
  }

  if (!data?.codeServerUrl) {
    return (
      <p className="text-text-dim p-4">
        Code-server is not enabled for this project. Enable it in the project settings.
      </p>
    );
  }

  const folder = searchParams.get('folder');
  const iframeSrc = folder
    ? `${data.codeServerUrl}?folder=${encodeURIComponent(folder)}`
    : data.codeServerUrl;

  return (
    <div className="-m-6" style={{ height: 'calc(100% + 3rem)' }}>
      <iframe
        src={iframeSrc}
        className="w-full h-full border-0"
        title="code-server workspace"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
}
