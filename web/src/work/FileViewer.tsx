import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ErrorState, Skeleton } from '@/components/states';
import { Dialog } from '@/components/ui';
import { imageUrl, isImagePath } from '@/lib/filePaths';
import { t } from '@/lib/i18n';
import type { ProjectFile } from '@/lib/types';
import { PluginBoundary, pluginOpensMedia, useUiPlugins } from '@/lib/uiPlugins';
import { Code, fmtBytes, useFetched } from './FilesPanel';

const LINE_PX = 12 * 1.55; // the font and line height of Code
const PAD_PX = 8;

const useViewer = create<{
  file: { tabId: string; path: string; line: number | null } | null;
  image: { src: string; title: string } | null;
}>(() => ({ file: null, image: null }));

export const openImage = (src: string, title: string) => useViewer.setState({ image: { src, title } });

/** A path from the chat: the file's own code, or the picture at full size. */
export function openPath(tabId: string, path: string, line: number | null = null) {
  if (isImagePath(path)) openImage(imageUrl(tabId, path), path);
  else useViewer.setState({ file: { tabId, path, line } });
}

function Viewer({ tabId, path, line }: { tabId: string; path: string; line: number | null }) {
  const { data, error, retry } = useFetched<ProjectFile>(`/api/tabs/${encodeURIComponent(tabId)}/file?path=${encodeURIComponent(path)}`, '');
  const box = useRef<HTMLDivElement>(null);
  const loaded = data !== null;
  const plugins = useUiPlugins();
  const PluginView = plugins.find((c) => c.fileView)?.fileView;
  const media = pluginOpensMedia(plugins, path);
  useEffect(() => {
    if (loaded && line && box.current) box.current.scrollTop = Math.max(0, (line - 1) * LINE_PX - 80);
  }, [loaded, line]);

  if (error && !data) return <div className="p-4"><ErrorState message={error} onRetry={retry} /></div>;
  if (!data) return <Skeleton className="p-4" lines={8} />;
  return (
    <>
      {data.truncated && !media && <p role="status" className="flex-none border-b border-line2 px-3 py-1 text-[11px] text-accent">{t('files.truncated', { size: fmtBytes(data.size) })}</p>}
      <div ref={box} className="relative min-h-0 flex-1 overflow-auto bg-bg">
        {data.kind === 'binary' && !media ? (
          <p className="p-3 text-xs text-dim">{t('files.binary', { size: fmtBytes(data.size) })}</p>
        ) : PluginView ? (
          <PluginBoundary fallback={<Code text={data.text ?? ''} />}><PluginView tabId={tabId} path={path} file={data} line={line} /></PluginBoundary>
        ) : data.text === '' ? (
          <p className="p-3 text-xs text-dim">{t('files.emptyFile')}</p>
        ) : (
          <>
            {line && <div data-testid="file-line" className="pointer-events-none absolute inset-x-0 bg-accent-bg" style={{ top: PAD_PX + (line - 1) * LINE_PX, height: LINE_PX }} />}
            <Code text={data.text ?? ''} />
          </>
        )}
      </div>
    </>
  );
}

/** One for the whole app: opened from any chat, the root one and a subagent's view included. */
export function FileViewer() {
  const file = useViewer((s) => s.file);
  const image = useViewer((s) => s.image);
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <>
      <Dialog open={file !== null} onOpenChange={(v) => { if (!v) useViewer.setState({ file: null }); }} title={file?.path ?? ''} width={960}>
        {file && <div className="-m-4 flex h-[75vh] min-h-0 flex-col"><Viewer key={`${file.tabId}:${file.path}`} {...file} /></div>}
      </Dialog>
      <Dialog open={image !== null} onOpenChange={(v) => { if (!v) useViewer.setState({ image: null }); }} title={image?.title ?? ''} width={1400}>
        {image && (broken === image.src ? (
          <p role="alert" className="text-xs text-muted">{t('chat.imageFailed')}</p>
        ) : (
          <img src={image.src} alt={image.title} onError={() => setBroken(image.src)} className="mx-auto max-h-[calc(100vh-180px)] max-w-full object-contain" />
        ))}
      </Dialog>
    </>
  );
}
