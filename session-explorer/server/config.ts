// ── Session Explorer Configuration ─────────────────────────────────

export const config = {
  // Server
  port: 5198,

  // Models
  chatModel: "claude-sonnet-4-6",
  summaryModel: "claude-haiku-4-5-20251001",

  // Chat
  chatMaxTokens: 4096,
  chatMaxToolIterations: 5,

  // Summarization
  summaryConcurrency: 5,
  summaryMaxTokens: 300,

  // Auto-ingest polling
  autoIngestIntervalMs: 30_000,

  // Insight extraction
  insightModel: "claude-sonnet-4-6",
  insightConcurrency: 3,
  insightMaxTokens: 4096,
  insightTranscriptMaxChars: 30_000,
  insightMaxAgeDays: 60,

  // Pagination
  defaultPageSize: 50,
  searchResultLimit: 100,
  fileSearchLimit: 50,

  // Meta layer
  metaScoringModel: "claude-haiku-4-5-20251001",
  metaAnalysisModel: "claude-sonnet-4-6",
  metaConcurrency: 3,
  metaMaxTokens: 4096,
  metaDefaultConfidenceThreshold: 0.7,
  metaDefaultScoringThreshold: 3.5,
  metaDefaultMinInvocations: 3,
};
