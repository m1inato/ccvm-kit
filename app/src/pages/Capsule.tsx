// 桌面胶囊：平时只占一条「受保护 · 出口 IP · 项目 · 计时」；做完或出问题时下面弹一句字幕。
import { duration } from '../../core/status';
import { act, useApp } from '../api';
import { Dot } from '../components/common';

export function CapsulePage() {
  const { snap, now, run } = useApp();
  const active = snap.projects.filter((p) => p.claudeSessions > 0).sort((a, b) => a.claudeSince - b.claudeSince)[0];
  const ip = snap.level === 'error'
    ? snap.issues[0]?.kind === 'egress_changed' ? snap.egress.vm ?? snap.egress.host : undefined
    : snap.egress.vm ?? snap.egress.baseline;
  const caption = snap.captions[snap.captions.length - 1];
  const open = (route?: string) => run(() => act('openMain', route));
  return (
    <div className="capsule-wrap">
      <div className={`capsule ${snap.level}`} onDoubleClick={() => open()}>
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
    </div>
  );
}
