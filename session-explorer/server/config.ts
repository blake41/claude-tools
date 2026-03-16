// ── Session Explorer Configuration ─────────────────────────────────

export const config = {
  // Server
  port: 5198,

  // Models
  chatModel: "claude-sonnet-4-6",
  summaryModel: "claude-haiku-4-5-20251001",

  // Chat
  chatMaxTokens: 4096,
  chatMaxToolIterations: 10,

  // Summarization
  summaryConcurrency: 5,
  summaryMaxTokens: 300,

  // Pagination
  defaultPageSize: 50,
  searchResultLimit: 100,
  fileSearchLimit: 50,
};
