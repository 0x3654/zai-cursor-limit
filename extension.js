const vscode = require('vscode');

const QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
const DASHBOARD_URL = 'https://z.ai/manage-apikey/coding-plan/personal/usage';
const FETCH_TIMEOUT_MS = 15000;

// Level names in green → yellow → red order; the palette itself lives in
// settings (zaiCursorLimit.<level>{Text,Tint}{Dark,Light}), each with the
// built-in defaults below. Text shades keep HSL saturation ~50% (lightness
// ~55% on dark themes, ~25% on light themes); title bar tints are medium on
// dark themes (red is burgundy) and pastel on light ones.
// StatusBarItem.backgroundColor is whitelist-only and does not even render in
// Cursor, so the traffic light colors the item TEXT instead — the .color
// property accepts raw hex (string | ThemeColor, no whitelist; see
// extHostStatusBar.ts).
const LEVELS = {
  green: {
    defaults: { textDark: '#53C679', textLight: '#206035', tintDark: '#339955', tintLight: '#339955' },
    setting: 'tintTitlebarOnGreen',
  },
  yellow: {
    defaults: { textDark: '#C6A953', textLight: '#605020', tintDark: '#8A7228', tintLight: '#8A7228' },
    setting: 'tintTitlebarOnYellow',
  },
  red: {
    defaults: { textDark: '#C65353', textLight: '#672222', tintDark: '#862D3B', tintLight: '#862D3B' },
    setting: 'tintTitlebarOnRed',
  },
};

// Title bar text colors enforced while a tint is applied: deep tints need a
// light foreground to stay readable on both light and dark themes.
const TITLEBAR_FG = { active: '#FFFFFF', inactive: '#E0E0E0' };

// Reads one palette entry: the setting value or its built-in default.
// `key` is a defaults-field name like "textDark" → setting "greenTextDark".
function paletteColor(level, key) {
  const settingKey = `${level}${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  const v = cfg().get(settingKey);
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : LEVELS[level].defaults[key];
}

// Multiplies a #rrggbb color by a factor (used to derive the inactive title
// bar shade from the active tint).
function darken(hex, f) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    return hex;
  }
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Current palette half: 'dark' or 'light' (high-contrast variants map to both).
function paletteKind() {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

/** @type {vscode.StatusBarItem} */
let statusItem = null;
// Level name suffixes for the per-level settings keys.
const CAP = { green: 'Green', yellow: 'Yellow', red: 'Red' };
/** @type {NodeJS.Timeout|null} */
let timer = null;
// In threshold-test mode: fake data { five: {pct}, week: {pct} }, otherwise false.
let testMode = false;
// True while the last colorCustomizations write failed — typically because the
// user settings.json is open with unsaved changes; retried every refresh.
let tintBlocked = false;
let tintWarned = false;

function cfg() {
  return vscode.workspace.getConfiguration('zaiCursorLimit');
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })} ${fmtTime(ms)}`;
}

// API format trap: in TIME_LIMIT the "usage" field is the quota size and
// "currentValue" is the consumption.
function parseQuota(json) {
  const limits = json && json.data && Array.isArray(json.data.limits) ? json.data.limits : [];
  const out = { level: (json && json.data && json.data.level) || '?', five: null, week: null };
  for (const l of limits) {
    if (l.type === 'TOKENS_LIMIT') {
      out.five = { pct: l.percentage || 0, resetMs: l.nextResetTime };
    } else if (l.type === 'TIME_LIMIT') {
      out.week = {
        pct: l.percentage || 0,
        used: l.currentValue,
        quota: l.usage,
        remaining: l.remaining,
        resetMs: l.nextResetTime,
        details: Array.isArray(l.usageDetails) ? l.usageDetails : [],
      };
    }
  }
  return out;
}

async function fetchQuota(apiKey) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(QUOTA_URL, {
      headers: { Authorization: apiKey, 'Accept-Language': 'en-US,en' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (invalid key)' : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function thresholds() {
  return { yellow: cfg().get('yellowPct'), red: cfg().get('redPct') };
}

function levelOf(maxPct) {
  const { yellow, red } = thresholds();
  if (maxPct >= red) {
    return 'red';
  }
  return maxPct >= yellow ? 'yellow' : 'green';
}

function maxPercentage(q) {
  return Math.max(q.five ? q.five.pct : 0, q.week ? q.week.pct : 0);
}

function tooltipFor(q, measuredAt, staleNote) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**[:] Z.ai GLM Coding Plan** (plan: ${q.level})\n\n`);
  if (q.five) {
    md.appendMarkdown(`- 5h tokens: **${q.five.pct}%** → resets ${fmtTime(q.five.resetMs)}\n`);
  }
  if (q.week) {
    const nums =
      typeof q.week.used === 'number' && typeof q.week.quota === 'number'
        ? ` (${q.week.used}/${q.week.quota}, left ${q.week.remaining ?? '?'})`
        : '';
    md.appendMarkdown(`- weekly: **${q.week.pct}%**${nums} → resets ${fmtDateTime(q.week.resetMs)}\n`);
  }
  if (staleNote) {
    md.appendMarkdown(`\ndata from **${fmtTime(measuredAt)}** (stale) · click to refresh`);
    // The error goes to the bottom: the data first, then why there is no fresh one.
    md.appendMarkdown(`\n\n---\n\n⚠ **${staleNote}** — retrying every 5 s`);
  } else {
    md.appendMarkdown(`\nmeasured at ${fmtTime(measuredAt)} · click to refresh`);
  }
  return md;
}

// Writes colorCustomizations; never throws. Fails when the user settings.json
// has unsaved changes in an editor — VS Code blocks writes to a dirty file.
async function tryWriteColors(value) {
  const wbc = vscode.workspace.getConfiguration('workbench');
  try {
    await wbc.update('colorCustomizations', value, vscode.ConfigurationTarget.Global);
    tintBlocked = false;
    tintWarned = false;
    return true;
  } catch (err) {
    tintBlocked = true;
    if (!tintWarned) {
      tintWarned = true;
      vscode.window.showWarningMessage(
        'Z.ai Cursor Limit: cannot write colors — the user settings.json has unsaved changes. Save it; the tint will apply on the next refresh.',
      );
    }
    return false;
  }
}

// Keys this extension owns in workbench.colorCustomizations. Ownership is
// unconditional: on restore they are removed whatever their value is, so a
// stale tint from any version (or a changed palette) can never survive.
// Non-managed user keys are always preserved.
const MANAGED_COLOR_KEYS = [
  'titleBar.activeBackground',
  'titleBar.inactiveBackground',
  'titleBar.activeForeground',
  'titleBar.inactiveForeground',
  'statusBar.background',
  'statusBar.noFolderBackground',
  'statusBarItem.warningBackground',
  'statusBarItem.errorBackground',
];

// Removes every managed key from the current colorCustomizations value.
function stripManaged(cc) {
  const next = { ...(cc || {}) };
  let removed = false;
  for (const k of MANAGED_COLOR_KEYS) {
    if (k in next) {
      delete next[k];
      removed = true;
    }
  }
  return { next, removed };
}

// Writes colorCustomizations back without our managed keys (no-op if absent).
async function clearManagedColors() {
  const wbc = vscode.workspace.getConfiguration('workbench');
  const cur = wbc.get('colorCustomizations');
  if (!cur || typeof cur !== 'object') {
    return;
  }
  const { next, removed } = stripManaged(cur);
  if (!removed) {
    return;
  }
  await tryWriteColors(Object.keys(next).length ? next : undefined);
}

// Applies the optional title bar tint for the level: strip everything we own
// from the current value, then add the wanted keys. Idempotent and
// self-healing by construction — no snapshots, no value matching.
async function applyColors(level) {
  const L = LEVELS[level];
  if (!cfg().get(L.setting)) {
    await clearManagedColors();
    return;
  }
  const pal = paletteKind();
  const tint = paletteColor(level, `tint${pal === 'light' ? 'Light' : 'Dark'}`);
  const wbc = vscode.workspace.getConfiguration('workbench');
  const { next } = stripManaged(wbc.get('colorCustomizations'));
  next['titleBar.activeBackground'] = tint;
  next['titleBar.inactiveBackground'] = darken(tint, 0.85);
  next['titleBar.activeForeground'] = TITLEBAR_FG.active;
  next['titleBar.inactiveForeground'] = TITLEBAR_FG.inactive;
  await tryWriteColors(next);
}

// Restores: simply drops everything we own.
async function restoreColors() {
  await clearManagedColors();
}

// The number shown in the bar, per statusbarMetric: the larger window (max,
// default), the 5-hour window, or the weekly window. The traffic light color
// always follows the max regardless of the displayed metric.
function shownPercentage(q) {
  const metric = cfg().get('statusbarMetric') || 'max';
  if (metric === '5h') {
    return q.five ? q.five.pct : 0;
  }
  if (metric === 'weekly') {
    return q.week ? q.week.pct : 0;
  }
  return maxPercentage(q);
}

// Last successful quota data (kept on fetch failures so the bar keeps showing
// the most recent numbers) plus its timestamp and the current fetch error.
let lastGood = null;
let fetchError = null;
/** @type {NodeJS.Timeout|null} fast retry timer while requests fail. */
let retryTimer = null;
/** @type {boolean} refresh re-entrancy guard. */
let inFlight = false;

function render(q) {
  const maxPct = maxPercentage(q);
  const level = levelOf(maxPct);

  // A single number in the bar, chosen by statusbarMetric. Full details in the tooltip.
  // The robot face + number are colored with the level color (text, not background),
  // per-level switchable, palette picked for the active theme kind.
  // While requests fail, a warning sign is prefixed and the tooltip explains
  // that the data is stale; retries run every 5 seconds.
  const pal = paletteKind();
  statusItem.text = fetchError ? `[:] ⚠ ${shownPercentage(q)}%` : `[:] ${shownPercentage(q)}%`;
  statusItem.color = cfg().get(`colorRobotOn${CAP[level]}`)
    ? paletteColor(level, `text${pal === 'light' ? 'Light' : 'Dark'}`)
    : undefined;
  statusItem.backgroundColor = undefined;
  statusItem.command = 'zaiCursorLimit.refresh';
  // On failures the tooltip keeps the data and appends the error at the
  // bottom — both what we have and why there is nothing newer.
  const md = tooltipFor(q, lastGood ? lastGood.at : Date.now(), fetchError || undefined);
  if (tintBlocked) {
    md.appendMarkdown('\n\n⚠ color overrides blocked: save the user settings.json');
  }
  statusItem.tooltip = md;
  statusItem.show();
}

function renderError(err) {
  statusItem.text = '[:] ⚠';
  statusItem.color = undefined;
  statusItem.backgroundColor = undefined;
  statusItem.command = 'zaiCursorLimit.refresh';
  statusItem.tooltip = `Z.ai Cursor Limit: ${err && err.message ? err.message : 'request failed'}\nretries every 5 s`;
  statusItem.show();
}

function renderNoKey() {
  statusItem.text = '[:] apiKey?';
  statusItem.color = undefined;
  statusItem.backgroundColor = undefined;
  // Click opens the settings so the key can be pasted right away.
  statusItem.command = {
    command: 'workbench.action.openSettings',
    title: 'Open Z.ai Cursor Limit settings',
    arguments: ['@ext:0x3654.zai-cursor-limit'],
  };
  statusItem.tooltip = 'Z.ai Cursor Limit: set zaiCursorLimit.apiKey in settings';
  statusItem.show();
}

async function refresh(manual) {
  // Status bar off = the extension is fully dormant: hide the item and
  // always restore any color overrides we ever wrote.
  if (!cfg().get('statusbarEnabled')) {
    statusItem.hide();
    fetchError = null;
    lastGood = null;
    await restoreColors();
    return;
  }

  if (testMode) {
    render(testMode);
    await applyColors(levelOf(maxPercentage(testMode)));
    return;
  }

  const apiKey = cfg().get('apiKey');
  if (!apiKey) {
    renderNoKey();
    await restoreColors();
    return;
  }

  if (inFlight) {
    return;
  }
  inFlight = true;
  try {
    const q = parseQuota(await fetchQuota(apiKey));
    fetchError = null;
    lastGood = { q, at: Date.now() };
    render(q);
    await applyColors(levelOf(maxPercentage(q)));
    if (manual) {
      const five = q.five ? `${q.five.pct}%` : '?';
      const week = q.week ? `${q.week.pct}%` : '?';
      vscode.window.showInformationMessage(`Z.ai: 5h ${five} · wk ${week}`);
    }
  } catch (err) {
    fetchError = err && err.message ? err.message : 'request failed';
    if (lastGood) {
      // Keep showing the most recent data with a warning sign.
      render(lastGood.q);
    } else {
      renderError(err);
    }
    // Retry every 5 seconds while requests fail; the regular interval takes
    // over again once a retry succeeds.
    if (!retryTimer) {
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          refresh(false);
        },
        5 * 1000,
      );
    }
  } finally {
    inFlight = false;
  }
}

function schedule() {
  if (timer) {
    clearInterval(timer);
  }
  const sec = Math.max(30, cfg().get('refreshSec') || 300);
  timer = setInterval(() => refresh(false), sec * 1000);
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  // Click refreshes; only the "no api key" state switches the click to open
  // this extension's settings page (set in renderNoKey).
  statusItem.command = 'zaiCursorLimit.refresh';
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('zaiCursorLimit.refresh', () => refresh(true)),
    vscode.commands.registerCommand('zaiCursorLimit.openDashboard', () =>
      vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL)),
    ),
    vscode.commands.registerCommand('zaiCursorLimit.resetColors', () =>
      restoreColors().then(() => vscode.window.showInformationMessage('Z.ai: colors reset')),
    ),
    vscode.commands.registerCommand('zaiCursorLimit.testThresholds', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '55% → yellow', data: { five: { pct: 55 }, week: { pct: 10 } } },
          { label: '95% → red + titlebar tint', data: { five: { pct: 10 }, week: { pct: 95 } } },
          { label: 'green (10%)', data: { five: { pct: 5 }, week: { pct: 10 } } },
          { label: 'disable test (real data)', data: null },
        ],
        { placeHolder: 'Test thresholds: use fake percentages' },
      );
      if (!pick) {
        return;
      }
      testMode = pick.data || false;
      await refresh(false);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('zaiCursorLimit')) {
        schedule();
        refresh(false);
      }
    }),
    // Re-pick the palette half when the user switches between light/dark themes.
    ...(vscode.window.onDidChangeActiveColorTheme
      ? [vscode.window.onDidChangeActiveColorTheme(() => refresh(false))]
      : []),
  );

  // First of all: remove any tint a previous session left behind.
  clearManagedColors().finally(() => {
    refresh(false);
    schedule();
  });
}

function deactivate() {
  if (timer) {
    clearInterval(timer);
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  // Best effort: remove our color overrides on window close/reload.
  return restoreColors();
}

module.exports = { activate, deactivate };
