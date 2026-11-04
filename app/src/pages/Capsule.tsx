// 桌面胶囊：平时只占一条「受保护 · 出口 IP · 项目 · 计时」；做完或出问题时下面弹一句字幕。
// 窗口跟着内容伸缩（主进程按这里量到的大小调整），透明的空白处不挡住下面的窗口。
import { useLayoutEffect, useRef } from 'react';
import { duration } from '../../core/status';
import { act, getBridge, useApp } from '../api';
import { Dot } from '../components/common';

function useReportSize() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void getBridge().then((b) => b.capsuleSize?.(r.width, r.height));
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return ref;
}

export function CapsulePage({ notice, onCloseNotice }: { notice?: string; onCloseNotice: () => void }) {
  const { snap, now, run } = useApp();
  const ref = useReportSize();
  const active = snap.projects.filter((p) => p.claudeSessions > 0).sort((a, b) => a.claudeSince - b.claudeSince)[0];
  const ip = snap.level === 'error'
    ? snap.issues[0]?.kind === 'egress_changed' ? snap.egress.vm ?? snap.egress.host : undefined
    : snap.egress.vm ?? snap.egress.baseline;
  const caption = snap.captions[snap.captions.length - 1];
  const open = (route?: string) => run(() => act('openMain', route));
  return (
    <div className="capsule-wrap" ref={ref}>
      {/* 整条胶囊是拖动区域：macOS 不会把拖动区域里的鼠标事件交给页面，所以打开主窗口只靠右边的按钮 */}
      <div className={`capsule ${snap.level}`}>
        <Dot level={snap.level} />
        <span>{snap.checking ? '正在检查' : snap.headline}</span>
        {ip && (
          <>
            <span className="sep-dot">·</span>
            <span className="ip">{ip}</span>
          </>
        )}
        {active && (
          <>
            <span className="sep-dot">·</span>
            <span>{active.name}</span>
            <span className="muted">Claude 工作中 {duration(active.claudeSince, now)}</span>
          </>
        )}
        <button className="btn sm ghost icon" title="打开主窗口" onClick={() => open()}>
          ⤢
        </button>
      </div>
      {caption && (
        <div className={`caption ${caption.level}`} key={caption.id}>
          <span>{caption.text}</span>
          <div className="row">
            <span className={`chip ${caption.level === 'error' ? 'err' : caption.level === 'ok' ? 'ok' : ''}`}>
              <Dot level={caption.level} />
              {caption.level === 'error' ? snap.headline : caption.project ? caption.project : caption.level === 'busy' ? '等你' : '好了'}
            </span>
            <span className="spacer" />
            {caption.level === 'error' ? (
              <>
                <button className="btn sm" onClick={() => open('/')}>
                  核实
                </button>
                {snap.vm.status === 'Running' && (
                  <button className="btn sm danger" onClick={() => run(() => act('vmStop'))}>
                    停止 VM
                  </button>
                )}
              </>
            ) : (
              <>
                {caption.project && (
                  <button className="btn sm" onClick={() => open(`/project/${encodeURIComponent(caption.project!)}`)}>
                    回到终端
                  </button>
                )}
                <button className="btn sm ghost" onClick={() => run(() => act('dismissCaption', caption.id))}>
                  知道了
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {notice && (
        <div className="caption error">
          <span>{notice}</span>
          <div className="row">
            <span className="spacer" />
            <button className="btn sm ghost" onClick={onCloseNotice}>
              知道了
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
