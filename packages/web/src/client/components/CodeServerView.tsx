import { useParams, useSearchParams } from 'react-router-dom';
import { deriveIdeUrl } from '../lib/code-server-url';

export default function CodeServerView() {
  const { name } = useParams<{ name: string }>();
  const [searchParams] = useSearchParams();

  const codeServerUrl = name ? deriveIdeUrl(name) : undefined;

  if (!name) {
    return <p className="text-text-dim p-4">No project specified.</p>;
  }

  if (!codeServerUrl) {
    return (
      <p className="text-text-dim p-4">
        Code-server is not enabled for this project. Enable it in the project settings.
      </p>
    );
  }

  const folder = searchParams.get('folder');
  const iframeSrc = folder
    ? `${codeServerUrl}?folder=${encodeURIComponent(folder)}`
    : codeServerUrl;

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
