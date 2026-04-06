import { useState, useEffect, useCallback } from "react";

// ── Types ───────────────────────────────────────────────────────────

interface MetaSettingsData {
  trigger_mode: "manual" | "cron" | "hook" | "cron+hook";
  cron_interval_hours: number;
  hook_enabled: boolean;
  scoring_threshold: number;
  min_invocations: number;
  confidence_threshold: number;
}

const DEFAULT_SETTINGS: MetaSettingsData = {
  trigger_mode: "manual",
  cron_interval_hours: 24,
  hook_enabled: false,
  scoring_threshold: 3.0,
  min_invocations: 3,
  confidence_threshold: 0.5,
};

const TRIGGER_MODES: Array<{ value: MetaSettingsData["trigger_mode"]; label: string; desc: string }> = [
  { value: "manual", label: "Manual", desc: "Run analysis on demand only" },
  { value: "cron", label: "Cron", desc: "Run on a recurring schedule" },
  { value: "hook", label: "Hook", desc: "Run after each session ends" },
  { value: "cron+hook", label: "Cron + Hook", desc: "Both scheduled and per-session" },
];

const HOOK_SCRIPT = `#!/bin/bash
# Post-session analysis hook
# Add to your Claude Code post-session hook configuration
SESSION_ID="$1"
curl -s -X POST "http://localhost:5198/api/meta/analyze/session/$SESSION_ID"`;

// ── Main Component ──────────────────────────────────────────────────

export default function MetaSettings() {
  const [settings, setSettings] = useState<MetaSettingsData>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch("/api/meta/settings")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load settings (${r.status})`);
        return r.json();
      })
      .then((data: MetaSettingsData) => {
        setSettings(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const update = useCallback(<K extends keyof MetaSettingsData>(key: K, value: MetaSettingsData[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const save = useCallback(() => {
    setSaving(true);
    setError(null);
    fetch("/api/meta/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to save settings (${r.status})`);
        setSaving(false);
        setDirty(false);
        setToast("Settings saved");
        setTimeout(() => setToast(null), 2000);
      })
      .catch((err: Error) => {
        setError(err.message);
        setSaving(false);
      });
  }, [settings]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-zinc-400 text-sm">Loading settings...</div>
      </div>
    );
  }

  const showCron = settings.trigger_mode === "cron" || settings.trigger_mode === "cron+hook";

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Meta Layer Settings</h1>
        {toast && (
          <span className="text-green-400 text-sm font-medium animate-pulse">{toast}</span>
        )}
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Trigger Mode */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide">Trigger mode</h2>
        <div className="grid grid-cols-2 gap-2">
          {TRIGGER_MODES.map(({ value, label, desc }) => (
            <label
              key={value}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                settings.trigger_mode === value
                  ? "bg-blue-600/10 border-blue-500/40"
                  : "bg-zinc-900 border-zinc-700 hover:border-zinc-600"
              }`}
            >
              <input
                type="radio"
                name="trigger_mode"
                value={value}
                checked={settings.trigger_mode === value}
                onChange={() => update("trigger_mode", value)}
                className="mt-0.5 accent-blue-500"
              />
              <div>
                <div className="text-sm font-medium text-white">{label}</div>
                <div className="text-xs text-zinc-500">{desc}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Cron interval */}
        {showCron && (
          <div className="flex items-center gap-3 pt-2 border-t border-zinc-700">
            <label className="text-sm text-zinc-400">Cron interval (hours)</label>
            <input
              type="number"
              min={1}
              max={168}
              value={settings.cron_interval_hours}
              onChange={(e) => update("cron_interval_hours", Math.max(1, Math.min(168, Number(e.target.value))))}
              className="w-20 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <span className="text-xs text-zinc-600">1-168 (7 days max)</span>
          </div>
        )}
      </div>

      {/* Thresholds */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-5">
        <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide">Thresholds</h2>

        {/* Scoring threshold */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-zinc-400">Scoring threshold</label>
            <span className="text-sm font-medium text-white">{settings.scoring_threshold.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={settings.scoring_threshold}
            onChange={(e) => update("scoring_threshold", Number(e.target.value))}
            className="w-full accent-blue-500 h-1.5"
          />
          <div className="flex justify-between text-xs text-zinc-600">
            <span>1.0</span>
            <span>Sessions below this are underperforming</span>
            <span>5.0</span>
          </div>
        </div>

        {/* Min invocations */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-zinc-400">Min invocations</label>
            <span className="text-sm font-medium text-white">{settings.min_invocations}</span>
          </div>
          <input
            type="number"
            min={1}
            max={20}
            value={settings.min_invocations}
            onChange={(e) => update("min_invocations", Math.max(1, Math.min(20, Number(e.target.value))))}
            className="w-20 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <div className="text-xs text-zinc-600">Minimum skill uses before amendment proposals (1-20)</div>
        </div>

        {/* Confidence threshold */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-zinc-400">Confidence threshold</label>
            <span className="text-sm font-medium text-white">{settings.confidence_threshold.toFixed(1)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={settings.confidence_threshold}
            onChange={(e) => update("confidence_threshold", Number(e.target.value))}
            className="w-full accent-blue-500 h-1.5"
          />
          <div className="flex justify-between text-xs text-zinc-600">
            <span>0.0</span>
            <span>Proposals below this confidence are hidden</span>
            <span>1.0</span>
          </div>
        </div>
      </div>

      {/* Hook setup */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-zinc-300 uppercase tracking-wide">Hook setup</h2>
        <p className="text-sm text-zinc-400">
          Copy this script into your Claude Code post-session hook configuration to trigger analysis automatically.
        </p>
        <div className="relative">
          <pre className="bg-zinc-950 border border-zinc-700 rounded-lg p-4 text-sm text-zinc-300 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
            {HOOK_SCRIPT}
          </pre>
          <button
            onClick={() => {
              navigator.clipboard.writeText(HOOK_SCRIPT).then(() => {
                setToast("Copied to clipboard");
                setTimeout(() => setToast(null), 2000);
              });
            }}
            className="absolute top-2 right-2 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded transition-colors"
          >
            Copy
          </button>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
        {dirty && <span className="text-xs text-zinc-500">Unsaved changes</span>}
      </div>
    </div>
  );
}
