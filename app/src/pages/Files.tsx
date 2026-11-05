// VM 里 cc 的家目录：浏览、上传（选文件、选文件夹、从 Finder 拖入）、新建文件夹、删除、下载单个文件。
// 所有操作都经 files.sh，以 cc 身份进行，只能碰 /home/cc 下面；上传、下载是后台任务，进度在「后台任务」页看。
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { isMacPath } from '../../core/vmpath';
import type { FileListing } from '../../core/types';
import { act, errorText, getBridge, useApp } from '../api';
import { formatBytes } from '../components/common';

const HOME = '/home/cc';

function when(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export function FilesPage({ path }: { path: string }) {
  const { snap, go, run } = useApp();
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const running = snap.vm.status === 'Running';
  const open = (p: string) => go(`/files/${encodeURIComponent(p)}`);

  const load = useCallback(async () => {
    if (!running) return;
    setLoading(true);
    try {
      setListing(await act('listFiles', path));
      setError(undefined);
    } catch (err) {
      setListing(null);
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [path, running]);

  useEffect(() => {
    setSelected(undefined);
    void load();
  }, [load]);

  const here = listing?.path ?? path;
  // 上传任务结束后刷新列表
  const pushing = snap.jobs.filter((j) => j.kind === 'push' && j.state === 'running').length;
  const prevPushing = useRef(pushing);
  useEffect(() => {
    if (pushing < prevPushing.current) void load();
    prevPushing.current = pushing;
  }, [pushing, load]);

  const crumbs = here.split('/').filter(Boolean);
  const sel = listing?.entries.find((e) => e.name === selected);
  const onMac = isMacPath(here);

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const bridge = await getBridge();
    const paths = bridge.pathsForFiles?.(Array.from(e.dataTransfer.files)) ?? [];
    if (!paths.length) return;
    await run(() => act('pushPaths', paths, here), `已开始上传 ${paths.length} 项，进度在「后台任务」里`);
  };

  const mkdir = async () => {
    const name = (newName ?? '').trim();
    if (!name) return;
    if (name.includes('/') || name === '.' || name === '..' || /[\n\r]/.test(name)) {
      await run(async () => {
        throw new Error('名字里不能有 / 和换行，也不能是 . 或 ..');
      });
      return;
    }
    const done = await run(async () => {
      await act('makeDir', join(here, name));
      return true;
    });
    if (done) {
      setNewName(null);
      void load();
    }
  };

  const remove = async () => {
    if (!sel) return;
    const done = await run(() => act('removePath', join(here, sel.name)));
    if (done) {
      setSelected(undefined);
      void load();
    }
  };

  return (
    <main
      className={`main files ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="page-head">
        <div className="grow">
          <h1>文件</h1>
          <div className="crumbs">
            {crumbs.map((c, i) => {
              const p = '/' + crumbs.slice(0, i + 1).join('/');
              const clickable = p === HOME || p.startsWith(HOME + '/');
              return (
                <span key={p}>
                  <span className="faint">/</span>
                  {clickable && p !== here ? <a onClick={() => open(p)}>{c}</a> : <span>{c}</span>}
                </span>
              );
            })}
          </div>
        </div>
        <div className="row wrap">
          <button className="btn sm" disabled={!running} onClick={() => run(() => act('chooseUpload', here, false), '已开始上传，进度在「后台任务」里')}>
            上传文件
          </button>
          <button className="btn sm" disabled={!running} onClick={() => run(() => act('chooseUpload', here, true), '已开始上传，进度在「后台任务」里')}>
            上传文件夹
          </button>
          {newName === null ? (
            <button className="btn sm" disabled={!running} onClick={() => setNewName('')}>
              新建文件夹
            </button>
          ) : (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void mkdir();
              }}
            >
              <input className="input" autoFocus placeholder="文件夹名字" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: 140 }} />
              <button className="btn sm primary" type="submit" disabled={!newName.trim()}>
                新建
              </button>
              <button className="btn sm ghost" type="button" onClick={() => setNewName(null)}>
                取消
              </button>
            </form>
          )}
          <button
            className="btn sm"
            disabled={!running || !sel || sel.file_type !== 'file'}
            title="只能下载单个普通文件"
            onClick={() => sel && run(() => act('pullFile', join(here, sel.name)), '已开始下载，进度在「后台任务」里')}
          >
            下载
          </button>
          <button className="btn sm danger" disabled={!running || !sel} onClick={() => void remove()}>
            删除
          </button>
          <button className="btn sm ghost icon" title="刷新" disabled={!running || loading} onClick={() => void load()}>
            ↻
          </button>
        </div>
      </div>
      {onMac && (
        <div className="callout warn">这里是 Mac 上的真实文件夹：在这里新建、修改、删除，改的都是你 Mac 上的文件。</div>
      )}
      {!running && <div className="empty">VM 没有运行。</div>}
      {running && error && <div className="callout err">{error}</div>}
      {running && listing && (
        <div className="card file-list">
          {here !== HOME && (
            <div className="file-row" onDoubleClick={() => open(here.replace(/\/[^/]+$/, '') || HOME)}>
              <span className="icon">↰</span>
              <span className="grow">..</span>
            </div>
          )}
          {listing.entries.length === 0 && <div className="empty">空文件夹。可以把文件从 Finder 拖进来。</div>}
          {listing.entries.map((e) => (
            <div
              key={e.name}
              className={`file-row ${selected === e.name ? 'selected' : ''}`}
              onClick={() => setSelected(e.name)}
              onDoubleClick={() => e.file_type === 'dir' && open(join(here, e.name))}
            >
              <span className="icon">{e.file_type === 'dir' ? '▸' : e.file_type === 'link' ? '↪' : '·'}</span>
              <span className="grow name">{e.name}</span>
              <span className="tiny muted size">{e.file_type === 'dir' ? '' : formatBytes(e.size)}</span>
              <span className="tiny faint when">{when(e.mtime)}</span>
            </div>
          ))}
          {listing.truncated && <div className="tiny faint" style={{ padding: 8 }}>只列出了前 {listing.truncated} 项。</div>}
        </div>
      )}
      <p className="tiny faint">双击打开文件夹。可以从 Finder 拖入文件或文件夹上传到当前位置；下载只支持单个普通文件（不跟符号链接）。上传、下载的进度在「后台任务」里。</p>
    </main>
  );
}
