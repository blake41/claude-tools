export type QuotaVerdict = { ok: true } | { ok: false; resetsAt: number }

export type QuotaCheck = () => Promise<QuotaVerdict>

export const alwaysOk: QuotaCheck = async () => ({ ok: true })
