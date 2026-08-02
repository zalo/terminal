import { useState, useEffect, useRef, useCallback } from 'react';
import FileViewer from './FileViewer';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number | null;
  modified: string;
}

interface DirectoryListing {
  path: string;
  parent: string | null;
  files: FileEntry[];
}

interface FileBrowserProps {
  /** Current working directory of the Claude Code session — when it changes, auto-navigate. */
  sessionCwd?: string;
  /** Context name (work / john / untrusted / tom / admin). Omitted = admin. */
  context?: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

type CreateMode = null | 'file' | 'folder';

export default function FileBrowser({ sessionCwd, context }: FileBrowserProps = {}) {
  const STORAGE_KEY = `fileBrowser_lastDir_${context || 'admin'}`;
  const withCtx = (url: string): string =>
    context ? `${url}${url.includes('?') ? '&' : '?'}context=${encodeURIComponent(context)}` : url;
  const ctxBody = (extra: Record<string, unknown>): Record<string, unknown> =>
    context ? { ...extra, context } : extra;
  const [currentPath, setCurrentPath] = useState('');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  // Track the last sessionCwd we auto-navigated to so we only re-navigate when it changes,
  // and users can still browse away freely.
  const lastSyncedCwdRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewingFile, setViewingFile] = useState<{ path: string; size: number | null } | null>(null);
  type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';
  interface UploadEntry {
    name: string;
    total: number;
    loaded: number;
    status: UploadStatus;
    error?: string;
  }
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const uploading = uploads.some((u) => u.status === 'queued' || u.status === 'uploading');
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const uploadCanceledRef = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const [dirSizes, setDirSizes] = useState<Record<string, number>>({});
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  // Fetch directory sizes asynchronously after listing loads
  useEffect(() => {
    if (!currentPath || !listing) return;
    const hasDirs = listing.files.some(f => f.type === 'directory');
    if (!hasDirs) return;

    let cancelled = false;
    setDirSizes({});
    fetch(withCtx(`/api/files/dir-sizes?path=${encodeURIComponent(currentPath)}`))
      .then(r => r.json())
      .then(data => { if (!cancelled) setDirSizes(data.sizes || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentPath, listing]);

  const fetchDirectory = async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(withCtx(`/api/files?path=${encodeURIComponent(path)}`));
      if (res.ok) {
        const data = await res.json();
        setListing(data);
        setCurrentPath(path);
        try { localStorage.setItem(STORAGE_KEY, path); } catch {}
      } else {
        const { error } = await res.json();
        setError(error || 'Failed to load directory');
      }
    } catch (e) {
      setError('Failed to load directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Prefer the session's cwd on first mount if we have it.
    if (sessionCwd) {
      lastSyncedCwdRef.current = sessionCwd;
      fetchDirectory(sessionCwd).then(() => {});
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      fetchDirectory(saved).then(() => {});
    } else {
      fetch(withCtx('/api/config'))
        .then(r => r.json())
        .then(cfg => fetchDirectory(cfg.rootPath || '/'))
        .catch(() => fetchDirectory('/'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  // Follow the agent: when session cwd changes server-side, jump to it.
  useEffect(() => {
    if (!sessionCwd) return;
    if (lastSyncedCwdRef.current === sessionCwd) return;
    lastSyncedCwdRef.current = sessionCwd;
    fetchDirectory(sessionCwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCwd]);

  // If the saved path fails, fall back to root
  useEffect(() => {
    if (error && currentPath === '' && listing === null) {
      fetch(withCtx('/api/config'))
        .then(r => r.json())
        .then(cfg => fetchDirectory(cfg.rootPath || '/'))
        .catch(() => fetchDirectory('/'));
    }
  }, [error]);

  const handleNavigate = (entry: FileEntry) => {
    if (entry.type === 'directory') {
      fetchDirectory(`${currentPath}/${entry.name}`);
    } else {
      setViewingFile({ path: `${currentPath}/${entry.name}`, size: entry.size });
    }
  };

  const handleNavigateUp = () => {
    if (listing?.parent) {
      fetchDirectory(listing.parent);
    }
  };

  const uploadOne = useCallback((file: File, index: number, targetPath: string): Promise<void> => {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      uploadXhrRef.current = xhr;

      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        setUploads((prev) =>
          prev.map((p, idx) =>
            idx === index ? { ...p, status: 'uploading', loaded: ev.loaded } : p,
          ),
        );
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploads((prev) =>
            prev.map((p, idx) =>
              idx === index ? { ...p, status: 'done', loaded: p.total } : p,
            ),
          );
        } else {
          let msg = `HTTP ${xhr.status}`;
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed?.uploaded?.[0]?.error) msg = parsed.uploaded[0].error;
            else if (parsed?.error) msg = parsed.error;
          } catch {}
          setUploads((prev) =>
            prev.map((p, idx) => (idx === index ? { ...p, status: 'error', error: msg } : p)),
          );
        }
        resolve();
      };

      xhr.onerror = () => {
        setUploads((prev) =>
          prev.map((p, idx) =>
            idx === index ? { ...p, status: 'error', error: 'Network error' } : p,
          ),
        );
        resolve();
      };

      xhr.onabort = () => {
        setUploads((prev) =>
          prev.map((p, idx) => (idx === index ? { ...p, status: 'canceled' } : p)),
        );
        resolve();
      };

      const fd = new FormData();
      fd.append('path', targetPath);
      fd.append('files', file);

      xhr.open('POST', withCtx('/api/files/upload'));
      xhr.send(fd);
    });
  }, [withCtx]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const initial: UploadEntry[] = Array.from(files).map((f) => ({
      name: f.name,
      total: f.size,
      loaded: 0,
      status: 'queued' as UploadStatus,
    }));
    setUploads(initial);
    uploadCanceledRef.current = false;
    setError('');

    const targetPath = currentPath;
    for (let i = 0; i < files.length; i++) {
      if (uploadCanceledRef.current) {
        setUploads((prev) =>
          prev.map((p, idx) =>
            idx >= i && (p.status === 'queued' || p.status === 'uploading')
              ? { ...p, status: 'canceled' }
              : p,
          ),
        );
        break;
      }
      await uploadOne(files[i], i, targetPath);
    }

    uploadXhrRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = '';
    await fetchDirectory(targetPath);
  };

  const handleCancelUploads = useCallback(() => {
    uploadCanceledRef.current = true;
    if (uploadXhrRef.current) {
      try { uploadXhrRef.current.abort(); } catch {}
    }
  }, []);

  const handleDismissUploadPanel = useCallback(() => {
    if (uploading) return; // refuse while in flight
    setUploads([]);
  }, [uploading]);

  const handleDownloadZip = async () => {
    setDownloading(true);
    try {
      const res = await fetch(withCtx(`/api/files/download-zip?path=${encodeURIComponent(currentPath)}`));
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const dirName = currentPath.split('/').pop() || 'download';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${dirName}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Download failed');
    } finally {
      setDownloading(false);
    }
  };

  // --- Create file/folder ---
  const openCreate = useCallback((mode: 'file' | 'folder') => {
    setCreateMode(mode);
    setCreateName('');
    setError('');
    setTimeout(() => createInputRef.current?.focus(), 50);
  }, []);

  const cancelCreate = useCallback(() => {
    setCreateMode(null);
    setCreateName('');
  }, []);

  const submitCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;

    setCreating(true);
    setError('');
    try {
      const fullPath = `${currentPath}/${name}`;
      const endpoint = createMode === 'folder' ? '/api/files/mkdir' : '/api/files/create';
      const res = await fetch(withCtx(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctxBody({ path: fullPath })),
      });
      if (res.ok) {
        setCreateMode(null);
        setCreateName('');
        await fetchDirectory(currentPath);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create');
      }
    } catch {
      setError('Failed to create');
    } finally {
      setCreating(false);
    }
  }, [createName, createMode, currentPath]);

  const handleCreateKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCreate();
    } else if (e.key === 'Escape') {
      cancelCreate();
    }
  }, [submitCreate, cancelCreate]);

  // --- Drag and drop to move files ---
  const handleDragStart = useCallback((e: React.DragEvent, entry: FileEntry) => {
    const src = `${currentPath}/${entry.name}`;
    setDragSource(src);
    e.dataTransfer.setData('text/plain', src);
    e.dataTransfer.effectAllowed = 'move';
  }, [currentPath]);

  const handleDragOver = useCallback((e: React.DragEvent, entry: FileEntry) => {
    if (entry.type !== 'directory') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(entry.name);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetEntry: FileEntry) => {
    e.preventDefault();
    setDropTarget(null);
    const src = e.dataTransfer.getData('text/plain');
    if (!src || targetEntry.type !== 'directory') return;

    const srcName = src.split('/').pop() || '';
    const dest = `${currentPath}/${targetEntry.name}/${srcName}`;

    if (src === dest) return;

    setError('');
    try {
      const res = await fetch(withCtx('/api/files/move'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctxBody({ src, dest })),
      });
      if (res.ok) {
        await fetchDirectory(currentPath);
      } else {
        const data = await res.json();
        setError(data.error || 'Move failed');
      }
    } catch {
      setError('Move failed');
    } finally {
      setDragSource(null);
    }
  }, [currentPath]);

  const handleDragEnd = useCallback(() => {
    setDragSource(null);
    setDropTarget(null);
  }, []);

  // Also allow dropping on the parent directory button
  const handleDropOnParent = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const src = e.dataTransfer.getData('text/plain');
    if (!src || !listing?.parent) return;

    const srcName = src.split('/').pop() || '';
    const dest = `${listing.parent}/${srcName}`;

    if (src === dest) return;

    try {
      const res = await fetch(withCtx('/api/files/move'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctxBody({ src, dest })),
      });
      if (res.ok) {
        await fetchDirectory(currentPath);
      } else {
        const data = await res.json();
        setError(data.error || 'Move failed');
      }
    } catch {
      setError('Move failed');
    } finally {
      setDragSource(null);
    }
  }, [currentPath, listing]);

  if (viewingFile) {
    return (
      <FileViewer
        filePath={viewingFile.path}
        fileSize={viewingFile.size}
        context={context}
        onBack={() => setViewingFile(null)}
      />
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#1a1a2e]">
      {/* Path header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-[#252540] border-b border-[#2d2d4a]">
        {listing?.parent && (
          <button
            onClick={handleNavigateUp}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget('..'); }}
            onDragLeave={handleDragLeave}
            onDrop={handleDropOnParent}
            className={`p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a] ${
              dropTarget === '..' ? 'ring-2 ring-[#4fd1c5] bg-[#2d2d4a]' : ''
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
        <span className="text-sm text-slate-300 font-mono truncate flex-1 min-w-0">
          {currentPath}
        </span>
        {/* New folder */}
        <button
          onClick={() => openCreate('folder')}
          className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a]"
          title="New folder"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
        </button>
        {/* New file */}
        <button
          onClick={() => openCreate('file')}
          className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a]"
          title="New file"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </button>
        {/* Download folder as zip */}
        <button
          onClick={handleDownloadZip}
          disabled={downloading}
          className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a] disabled:opacity-40"
          title="Download folder as zip"
        >
          {downloading ? (
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          )}
        </button>
        {/* Upload button */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleUpload}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a] disabled:opacity-40"
          title="Upload files to current directory"
        >
          {uploading ? (
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          )}
        </button>
      </div>

      {/* Create inline input */}
      {createMode && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#1e1e38] border-b border-[#2d2d4a]">
          {createMode === 'folder' ? (
            <svg className="w-5 h-5 text-[#4fd1c5] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
            </svg>
          )}
          <input
            ref={createInputRef}
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            onKeyDown={handleCreateKeyDown}
            placeholder={createMode === 'folder' ? 'Folder name' : 'filename.ext'}
            className="flex-1 bg-[#252540] text-white rounded-lg px-3 py-2 text-sm border border-[#3d3d5c] focus:border-[#4fd1c5] focus:outline-none placeholder-slate-500 min-w-0"
          />
          <button
            onClick={submitCreate}
            disabled={creating || !createName.trim()}
            className="px-3 py-2 bg-[#4fd1c5] text-[#1a1a2e] rounded-lg text-sm font-medium hover:bg-[#38b2ac] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            {creating ? '...' : 'Create'}
          </button>
          <button
            onClick={cancelCreate}
            className="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-[#2d2d4a] flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="text-slate-400 text-center py-8">Loading...</div>
        ) : error ? (
          <div className="text-red-400 text-center py-8">{error}</div>
        ) : listing?.files.length === 0 ? (
          <div className="text-slate-400 text-center py-8">Empty directory</div>
        ) : (
          <ul className="divide-y divide-[#2d2d4a]">
            {listing?.files.map((entry) => {
              const isDropping = dropTarget === entry.name && entry.type === 'directory';
              const isDragging = dragSource === `${currentPath}/${entry.name}`;
              return (
                <li key={entry.name}>
                  <div
                    className={`w-full px-4 py-3 flex items-center gap-3 hover:bg-[#252540] transition-colors text-left ${
                      isDropping ? 'bg-[#2d2d4a] ring-1 ring-inset ring-[#4fd1c5]' : ''
                    } ${isDragging ? 'opacity-40' : ''}`}
                    onDragOver={(e) => handleDragOver(e, entry)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, entry)}
                  >
                    {/* Draggable icon */}
                    <div
                      draggable
                      onDragStart={(e) => handleDragStart(e, entry)}
                      onDragEnd={handleDragEnd}
                      className="cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
                    >
                      {entry.type === 'directory' ? (
                        <svg className="w-5 h-5 text-[#4fd1c5]" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-slate-400" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>
                    {/* Clickable name + size */}
                    <button
                      onClick={() => handleNavigate(entry)}
                      className="flex-1 flex items-center gap-3 min-w-0 text-left"
                    >
                      <span className="flex-1 text-white truncate">
                        {entry.name}
                        {entry.type === 'directory' && '/'}
                      </span>
                      <span className="text-slate-500 text-sm whitespace-nowrap">
                        {entry.type === 'file' && entry.size !== null
                          ? formatSize(entry.size)
                          : entry.type === 'directory' && dirSizes[entry.name] !== undefined
                            ? formatSize(dirSizes[entry.name])
                            : entry.type === 'directory' ? '\u00B7\u00B7\u00B7' : ''}
                      </span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Upload progress panel — fixed overlay shown while uploads are in
          flight or until dismissed after completion */}
      {uploads.length > 0 && (
        <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:w-96 bg-[#252540] border border-[#2d2d4a] rounded-lg shadow-xl z-50 flex flex-col max-h-[60vh]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#2d2d4a]">
            <div className="text-sm text-white font-medium">
              {(() => {
                const done = uploads.filter(u => u.status === 'done').length;
                const failed = uploads.filter(u => u.status === 'error').length;
                const canceled = uploads.filter(u => u.status === 'canceled').length;
                const active = uploads.length - done - failed - canceled;
                if (active > 0) return `Uploading ${done + 1}/${uploads.length}`;
                if (failed > 0 || canceled > 0) return `Done — ${done} ok, ${failed} failed${canceled ? `, ${canceled} canceled` : ''}`;
                return `Uploaded ${done} file${done === 1 ? '' : 's'}`;
              })()}
            </div>
            {uploading ? (
              <button
                onClick={handleCancelUploads}
                className="text-xs text-red-300 hover:text-red-200 font-medium px-2 py-1 rounded hover:bg-[#2d2d4a]"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={handleDismissUploadPanel}
                className="text-slate-400 hover:text-white text-xs"
                title="Dismiss"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <div className="overflow-y-auto px-4 py-3 space-y-3">
            {uploads.map((u, i) => {
              const pct = u.total > 0 ? Math.min(100, Math.round((u.loaded / u.total) * 100)) : 0;
              const barColor =
                u.status === 'error'    ? '#fc8181' :
                u.status === 'canceled' ? '#a0aec0' :
                u.status === 'done'     ? '#68d391' :
                u.status === 'uploading'? '#4fd1c5' :
                                          '#3d3d5c';
              const rightText =
                u.status === 'error'    ? (u.error || 'Failed') :
                u.status === 'canceled' ? 'Canceled' :
                u.status === 'done'     ? formatSize(u.total) :
                                          `${formatSize(u.loaded)} / ${formatSize(u.total)}  ·  ${pct}%`;
              return (
                <div key={`${u.name}-${i}`} className="text-xs">
                  <div className="flex justify-between gap-3 mb-1">
                    <span className="text-slate-200 truncate flex-1 min-w-0" title={u.name}>{u.name}</span>
                    <span
                      className="flex-shrink-0 font-mono"
                      style={{ color: u.status === 'error' ? '#fc8181' : '#94a3b8' }}
                    >
                      {rightText}
                    </span>
                  </div>
                  <div className="h-1.5 bg-[#1a1a2e] rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-150 ${u.status === 'uploading' ? '' : ''}`}
                      style={{ width: `${u.status === 'done' ? 100 : pct}%`, backgroundColor: barColor }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
