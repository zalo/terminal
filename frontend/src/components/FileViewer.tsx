import { useState, useEffect, useRef, useCallback } from 'react';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

interface FileViewerProps {
  filePath: string;
  /** Pre-known file size in bytes. When >500 KB we skip the text preview to
   *  avoid freezing the browser on huge text-but-not-meant-to-be-viewed files. */
  fileSize?: number | null;
  context?: string;
  onBack: () => void;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);

// Text-serialized formats that are technically readable but routinely huge
// and not intended for inline viewing (3D mesh, CAD, G-code, scientific
// dumps). Open these would freeze the highlighter on multi-MB files.
const NON_PREVIEWABLE_TEXT_EXTS = new Set([
  // 3D mesh / scene
  '.obj', '.stl', '.ply', '.dae', '.gltf', '.x3d', '.vrml', '.wrl',
  // CAD
  '.step', '.stp', '.iges', '.igs', '.ifc',
  // CAM / CNC
  '.gcode', '.nc', '.ngc',
  // Scientific
  '.pdb', '.mol2', '.cif', '.mmcif',
  // LDraw / brick-CAD
  '.ldr', '.ldraw', '.mpd',
  // SVG can be huge for diagrams — leave it previewable as it renders as image
]);

// Anything text-shaped above this size, we refuse to load inline.
const PREVIEW_MAX_TEXT_BYTES = 500 * 1024;

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return parseFloat((n / Math.pow(k, i)).toFixed(1)) + ' ' + units[i];
}

function getLanguage(extension: string): string | undefined {
  const map: Record<string, string> = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp',
    '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
    '.ps1': 'powershell', '.sql': 'sql', '.html': 'html', '.htm': 'html',
    '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
    '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml', '.ini': 'ini', '.md': 'markdown', '.markdown': 'markdown',
    '.dockerfile': 'dockerfile', '.makefile': 'makefile', '.cmake': 'cmake',
    '.graphql': 'graphql', '.gql': 'graphql', '.vue': 'vue', '.svelte': 'svelte',
  };
  return map[extension.toLowerCase()];
}

export default function FileViewer({ filePath, fileSize, context, onBack }: FileViewerProps) {
  const ctxSuffix = context ? `&context=${encodeURIComponent(context)}` : '';
  const [textContent, setTextContent] = useState<{ content: string; extension: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [zoomed, setZoomed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [forcePreview, setForcePreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ext = ('.' + filePath.split('.').pop()).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const isVideo = VIDEO_EXTS.has(ext);
  const isTextFile = !isImage && !isVideo;
  const streamUrl = `/api/files/stream?path=${encodeURIComponent(filePath)}${ctxSuffix}`;
  const downloadUrl = `/api/files/stream?path=${encodeURIComponent(filePath)}&download=1${ctxSuffix}`;
  const fileName = filePath.split('/').pop() || '';

  // Decide whether to skip the inline preview entirely.
  const skipReason: 'format' | 'size' | null = (() => {
    if (isImage || isVideo) return null;
    if (forcePreview) return null;
    if (NON_PREVIEWABLE_TEXT_EXTS.has(ext)) return 'format';
    if (typeof fileSize === 'number' && fileSize > PREVIEW_MAX_TEXT_BYTES) return 'size';
    return null;
  })();

  useEffect(() => {
    if (isImage || isVideo) return;
    if (skipReason) return;
    setLoading(true);
    setError('');
    fetch(`/api/files/content?path=${encodeURIComponent(filePath)}${ctxSuffix}`)
      .then(r => r.ok ? r.json() : r.json().then((d: { error: string }) => Promise.reject(d.error)))
      .then(data => setTextContent({ content: data.content, extension: data.extension }))
      .catch(e => setError(typeof e === 'string' ? e : 'Failed to load file'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, skipReason]);

  const enterEditMode = useCallback(() => {
    if (!textContent) return;
    setEditText(textContent.content);
    setEditing(true);
    setDirty(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [textContent]);

  const exitEditMode = useCallback(() => {
    if (dirty) {
      if (!confirm('Discard unsaved changes?')) return;
    }
    setEditing(false);
    setDirty(false);
  }, [dirty]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/files/content${context ? `?context=${encodeURIComponent(context)}` : ''}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: editText, ...(context ? { context } : {}) }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      // Update the viewed content and exit edit mode
      setTextContent(prev => prev ? { ...prev, content: editText } : prev);
      setEditing(false);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [filePath, editText]);

  const handleEditChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditText(e.target.value);
    setDirty(true);
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+S to save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    // Tab inserts spaces instead of changing focus
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newText = editText.substring(0, start) + '  ' + editText.substring(end);
      setEditText(newText);
      setDirty(true);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    }
  }, [editText, handleSave]);

  const renderContent = () => {
    if (isImage) {
      return (
        <div className="flex items-center justify-center p-4 min-h-[200px]">
          <img
            src={streamUrl}
            alt={fileName}
            className="max-w-full max-h-[70vh] object-contain cursor-zoom-in"
            onClick={() => setZoomed(true)}
          />
        </div>
      );
    }

    if (isVideo) {
      return (
        <div className="flex items-center justify-center p-4">
          <video
            src={streamUrl}
            controls
            className="max-w-full max-h-[75vh]"
          />
        </div>
      );
    }

    if (skipReason) {
      const headline = skipReason === 'format'
        ? `Preview skipped — ${ext} files are serialized data, not meant for inline viewing.`
        : `Preview skipped — file is ${typeof fileSize === 'number' ? formatBytes(fileSize) : 'too large'} (limit ${formatBytes(PREVIEW_MAX_TEXT_BYTES)} for text).`;
      const subtext = skipReason === 'format'
        ? `Loading a multi-MB ${ext} file would freeze the page while highlight.js tries to tokenize it.`
        : `Open it in a desktop editor that's built for files this size.`;
      return (
        <div className="flex flex-col items-center justify-center text-center px-6 py-12 gap-4">
          <svg className="w-16 h-16 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2a4 4 0 014-4h3M7 7h.01M11 7h6a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2h4l4 4" />
          </svg>
          <div className="space-y-1 max-w-md">
            <p className="text-slate-200 text-sm">{headline}</p>
            <p className="text-slate-500 text-xs">{subtext}</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <a
              href={downloadUrl}
              download={fileName}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#4fd1c5] text-[#1a1a2e] rounded-lg text-sm font-medium hover:bg-[#38b2ac] transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
              </svg>
              Download {typeof fileSize === 'number' ? `(${formatBytes(fileSize)})` : ''}
            </a>
            <button
              onClick={() => setForcePreview(true)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 underline decoration-dotted underline-offset-4"
            >
              Try anyway
            </button>
          </div>
        </div>
      );
    }
    if (loading) return <div className="text-slate-400 text-center py-8">Loading...</div>;
    if (error) return <div className="text-red-400 text-center py-8">{error}</div>;
    if (!textContent) return <div className="text-slate-400 text-center py-8">No content</div>;

    if (editing) {
      return (
        <div className="flex flex-col h-full">
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={handleEditChange}
            onKeyDown={handleEditKeyDown}
            spellCheck={false}
            className="flex-1 w-full bg-[#1a1a2e] text-slate-200 font-mono text-sm p-3 resize-none focus:outline-none leading-relaxed"
            style={{ tabSize: 2 }}
          />
        </div>
      );
    }

    const language = getLanguage(textContent.extension);
    let highlighted: string;
    try {
      highlighted = language
        ? hljs.highlight(textContent.content, { language }).value
        : hljs.highlightAuto(textContent.content).value;
    } catch {
      highlighted = textContent.content
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    const lines = highlighted.split('\n');
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-[#2d2d4a]">
                <td className="px-3 py-0.5 text-right text-slate-500 select-none border-r border-[#2d2d4a] w-12">
                  {i + 1}
                </td>
                <td
                  className="px-3 py-0.5 text-slate-200 whitespace-pre"
                  dangerouslySetInnerHTML={{ __html: line || ' ' }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-[#1a1a2e]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-[#252540] border-b border-[#2d2d4a]">
        <button
          onClick={editing ? exitEditMode : onBack}
          className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a] flex-shrink-0"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm text-white font-medium truncate flex-1 min-w-0">
          {fileName}
          {editing && dirty && <span className="text-[#4fd1c5] ml-1">(modified)</span>}
        </span>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Edit / Save — only for text files */}
          {isTextFile && textContent && !loading && (
            editing ? (
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="px-3 py-1.5 bg-[#4fd1c5] text-[#1a1a2e] rounded-lg text-sm font-medium hover:bg-[#38b2ac] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            ) : (
              <button
                onClick={enterEditMode}
                className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a]"
                title="Edit file"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            )
          )}

          {/* Download — for every file type, hidden while editing */}
          {!editing && (
            <a
              href={downloadUrl}
              download={fileName}
              className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a] inline-flex"
              title="Download file"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
              </svg>
            </a>
          )}
        </div>
      </div>

      {/* Content */}
      <div className={`flex-1 overflow-y-auto ${editing ? '' : 'bg-[#252540]'}`}>
        {renderContent()}
      </div>

      {/* Zoom lightbox */}
      {zoomed && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setZoomed(false)}
        >
          <img
            src={streamUrl}
            alt={fileName}
            className="max-w-full max-h-full object-contain cursor-zoom-out"
          />
        </div>
      )}
    </div>
  );
}
