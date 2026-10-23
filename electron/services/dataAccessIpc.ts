import { ipcMain } from 'electron'
import { dataAccessService, type DataAccessScope } from './dataAccessService'

export function registerDataAccessIpc(currentAccount: () => string): void {
  ipcMain.handle('data-access:currentAccount', () => currentAccount())
  ipcMain.handle('data-access:list', () => dataAccessService.list())
  ipcMain.handle('data-access:create', (_event, value: DataAccessScope & { name: string; expiresAt: number }) => {
    if (value?.accountId !== currentAccount()) throw new Error('The selected account changed. Select the scope again.')
    return dataAccessService.create(value)
  })
  ipcMain.handle('data-access:revoke', (_event, id: string) => dataAccessService.revoke(String(id)))
}
