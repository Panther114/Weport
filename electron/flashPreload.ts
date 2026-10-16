import { contextBridge, ipcRenderer } from 'electron'

const allowed = new Set(['key:dbKeyStatus', 'flash:note', 'export:progress', 'flash:result', 'flash:error'])
contextBridge.exposeInMainWorld('flash', {
  invoke(command: string, args?: { skipMedia?: boolean; account?: string }) {
    if (command === 'flash_info') return ipcRenderer.invoke('flash:info')
    if (command === 'flash_accounts') return ipcRenderer.invoke('flash:accounts')
    if (command === 'flash_choose_directory') return ipcRenderer.invoke('flash:chooseDirectory')
    if (command === 'flash_start') return ipcRenderer.invoke('flash:start', args?.skipMedia === true, args?.account)
    if (command === 'flash_open_folder') return ipcRenderer.invoke('flash:openFolder')
    return Promise.reject(new Error('Unknown command'))
  },
  listen(channel: string, callback: (event: { payload: unknown }) => void) {
    if (!allowed.has(channel)) return () => undefined
    const handler = (_event: unknown, payload: unknown) => callback({ payload })
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
})
