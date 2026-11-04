// 沙盒预加载：只暴露这几个入口。界面拿不到 Node、文件系统或 shell。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('ccvm', {
  snapshot: () => ipcRenderer.invoke('ccvm:snapshot'),
  act: (name: string, args: unknown[]) => ipcRenderer.invoke('ccvm:act', name, args),
  onSnapshot: (cb: (snap: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, snap: unknown) => cb(snap);
    ipcRenderer.on('ccvm:snapshot', listener);
    return () => ipcRenderer.removeListener('ccvm:snapshot', listener);
  },
  term: {
    open: (spec: unknown) => ipcRenderer.invoke('ccvm:term:open', spec),
    write: (id: string, data: string) => ipcRenderer.send('ccvm:term:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('ccvm:term:resize', id, cols, rows),
    close: (id: string) => ipcRenderer.invoke('ccvm:term:close', id),
    onData: (cb: (id: string, data: string) => void) => {
      const listener = (_e: IpcRendererEvent, id: string, data: string) => cb(id, data);
      ipcRenderer.on('ccvm:term:data', listener);
      return () => ipcRenderer.removeListener('ccvm:term:data', listener);
    },
    onExit: (cb: (id: string, code: number) => void) => {
      const listener = (_e: IpcRendererEvent, id: string, code: number) => cb(id, code);
      ipcRenderer.on('ccvm:term:exit', listener);
      return () => ipcRenderer.removeListener('ccvm:term:exit', listener);
    },
  },
  /** 胶囊页面报告内容大小，主进程据此调整窗口（只认胶囊窗口发来的） */
  capsuleSize: (width: number, height: number) => ipcRenderer.send('ccvm:capsule:size', width, height),
  onNavigate: (cb: (route: string) => void) => {
    const listener = (_e: IpcRendererEvent, route: unknown) => {
      if (typeof route === 'string') cb(route);
    };
    ipcRenderer.on('ccvm:navigate', listener);
    return () => ipcRenderer.removeListener('ccvm:navigate', listener);
  },
});
