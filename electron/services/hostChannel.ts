/** WCDB host replies use the parent process Node IPC channel. */
export function sendToHost(msg: any): void {
  try {
    const send = (process as any).send
    if (typeof send === 'function') send.call(process, msg)
  } catch {
    /* 父进程已断开 */
  }
}
