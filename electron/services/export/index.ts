import { ExportContext } from './core/ExportContext'
import { ExportOrchestrator } from './core/ExportOrchestrator'
import { ExportStatsService } from './stats/ExportStatsService'
import { ExportOptions, ExportProgress, ExportTaskControl, ExportStatsResult, AggregatedSessionStatsCacheEntry } from './types'

export * from './types'
export * from './utils/parallelLimit'

export class ExportServiceFacade {
  public context: ExportContext
  public orchestrator: ExportOrchestrator
  public statsService: ExportStatsService

  constructor() {
    this.context = new ExportContext()
    this.orchestrator = new ExportOrchestrator(this.context)
    this.statsService = new ExportStatsService(this.context)
  }

  setRuntimeConfig(config: any): void {
    return this.context.setRuntimeConfig(config)
  }

  setWeliveRawExportPaths(paths: Record<string, string> | null | undefined): void {
    return this.context.setWeliveRawExportPaths(paths)
  }

  clearWeliveRawExportPaths(): void {
    return this.context.clearWeliveRawExportPaths()
  }

  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ) {
    return this.orchestrator.exportSessions(sessionIds, outputDir, options, onProgress, control)
  }

  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl
  ) {
    return this.orchestrator.exportSessionToChatLab(sessionId, outputPath, options, onProgress, control)
  }

  async getExportStats(
    sessionIds: string[],
    options: ExportOptions
  ): Promise<ExportStatsResult> {
    return this.statsService.getExportStats(sessionIds, options)
  }

  async getAggregatedSessionStats(
    sessionIds: string[],
    options: ExportOptions
  ): Promise<AggregatedSessionStatsCacheEntry | null> {
    return this.statsService.getAggregatedSessionStats(sessionIds, options)
  }
}

export const exportService = new ExportServiceFacade()
