export interface ChatHistoryDisplay {
  title: string
  rows: Array<{ time: string; sender: string; text: string }>
  hasMore: boolean
  clipped: boolean
}
