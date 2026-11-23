export const STYLE_ID = "lumiverse-party-games-styles";

const BORDER = "var(--lumiverse-border,#34363c)";
const MUTED = "var(--lumiverse-text-muted,#9da0a8)";
const PRIMARY = "var(--lumiverse-primary,#8b7cff)";
const ELEVATED = "var(--lumiverse-bg-elevated,#202126)";
const BG = "var(--lumiverse-bg,#16171b)";

export const partyStyles = [
  ".pg-root{color:var(--lumiverse-text,#ececf1);font:13px/1.45 system-ui,sans-serif;padding:12px;max-width:760px;margin:auto;box-sizing:border-box}",
  ".pg-root *{box-sizing:border-box}",
  ".pg-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px}",
  ".pg-header h2{font-size:18px;margin:0 0 2px}.pg-muted{color:" + MUTED + ";margin:0}",
  ".pg-section{background:" + ELEVATED + ";border:1px solid " + BORDER + ";border-radius:9px;padding:12px;margin:0 0 12px}",
  ".pg-section h3{font-size:14px;margin:0 0 9px}",
  ".pg-notice{border-left:3px solid #e7ad42;background:color-mix(in srgb,#e7ad42 11%,transparent);padding:8px 10px;margin:0 0 12px;border-radius:4px}",
  ".pg-notice.error{border-color:#e66161;background:color-mix(in srgb,#e66161 11%,transparent)}",
  ".pg-notice.info{border-color:" + PRIMARY + ";background:color-mix(in srgb," + PRIMARY + " 11%,transparent)}",
  ".pg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pg-row.between{justify-content:space-between}",
  ".pg-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
  ".pg-button{appearance:none;border:1px solid var(--lumiverse-border,#4c4e56);border-radius:6px;background:" + BG + ";color:inherit;padding:6px 11px;cursor:pointer;font:inherit}",
  ".pg-button.primary{background:" + PRIMARY + ";border-color:" + PRIMARY + ";color:#fff}.pg-button.danger{border-color:#c75a5a}",
  ".pg-button:disabled{opacity:.48;cursor:not-allowed}.pg-button.small{padding:3px 8px;font-size:12px}",
  ".pg-input,.pg-select{min-height:30px;padding:4px 8px;border:1px solid " + BORDER + ";border-radius:6px;background:" + BG + ";color:inherit;font:inherit;min-width:0}",
  ".pg-check{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;margin:8px 0 0}.pg-check input{margin:2px 0 0;accent-color:" + PRIMARY + "}",
  ".pg-input{flex:1 1 160px}.pg-field{display:grid;gap:4px;margin:8px 0 0}.pg-label{font-weight:600;font-size:12px}",
  ".pg-games{display:grid;gap:6px}.pg-game{display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid " + BORDER + ";border-radius:7px;cursor:pointer}",
  ".pg-game[aria-disabled=true]{opacity:.55;cursor:not-allowed}.pg-game input{margin-top:3px;accent-color:" + PRIMARY + "}",
  ".pg-game-name{font-weight:650}.pg-soon{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:" + MUTED + ";margin-left:6px}",
  ".pg-seats{display:grid;gap:6px}.pg-seat{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:6px;align-items:center}.pg-seat .pg-input{width:100%}",
  ".pg-seat.user{min-height:30px}.pg-seat.user .pg-check{grid-column:2 / span 2;margin:0;align-items:center}",
  ".pg-rules{display:grid;gap:8px;margin-top:8px}.pg-rule{display:grid;grid-template-columns:30px minmax(0,1fr) minmax(0,1fr);gap:6px;align-items:center;padding:8px;border:1px solid " + BORDER + ";border-radius:7px}",
  ".pg-rule-rank{font:700 14px/1 ui-monospace,Consolas,monospace;text-align:center}.pg-rule .pg-select{width:100%}.pg-rule-locked{color:" + MUTED + ";font-size:12px}",
  ".pg-textarea{grid-column:2 / span 2;width:100%;min-height:46px;resize:vertical;line-height:1.35}.pg-textarea.wide{grid-column:auto}",
  ".pg-subhead{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:" + MUTED + ";margin:12px 0 4px}",
  ".pg-prompts{display:grid;gap:2px}.pg-prompt{margin:0;padding:4px 0}.pg-prompt.off{opacity:.45}.pg-prompt .pg-badge{margin-right:2px}",
  ".pg-pool{margin:0}.pg-pool.bad{color:#ef8b8b}",
  ".pg-actions.first{margin-top:0}.pg-notes{margin:8px 0 0;padding-left:18px;color:" + MUTED + ";font-size:12px}.pg-notes b{font-weight:600}",
  ".pg-seat-number{color:" + MUTED + ";font:600 12px/1 ui-monospace,Consolas,monospace;text-align:right}",
  ".pg-headline{font-size:16px;font-weight:700;margin:0}.pg-detail{margin:4px 0 0}",
  ".pg-kicker{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:" + MUTED + "}",
  ".pg-turn{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:12px}.pg-turn b{font-weight:650}",
  ".pg-players{list-style:none;margin:0;padding:0;display:grid;gap:4px}",
  ".pg-player{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;border-radius:6px;border:1px solid transparent}",
  ".pg-player.current{border-color:" + PRIMARY + ";background:color-mix(in srgb," + PRIMARY + " 12%,transparent)}.pg-player.out{opacity:.5;text-decoration:line-through}",
  ".pg-badge{font-size:10px;font-weight:700;letter-spacing:.03em;padding:1px 6px;border-radius:999px;border:1px solid " + BORDER + ";color:" + MUTED + "}",
  ".pg-badge.turn{border-color:" + PRIMARY + ";color:" + PRIMARY + "}.pg-badge.next{border-color:#77c68e;color:#77c68e}",
  ".pg-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}.pg-facts dt{color:" + MUTED + "}.pg-facts dd{margin:0;overflow-wrap:anywhere}",
  ".pg-log{margin:0;padding-left:18px;color:" + MUTED + ";font-size:12px}",
  ".pg-action{border-top:1px solid " + BORDER + ";padding-top:10px;margin-top:10px}.pg-action:first-child{border-top:0;padding-top:0;margin-top:0}",
  ".pg-preview{white-space:pre-wrap;max-height:220px;overflow:auto;background:" + BG + ";border:1px solid " + BORDER + ";border-radius:6px;padding:9px;margin:6px 0 0;font:12px/1.35 ui-monospace,Consolas,monospace}",
  ".pg-details summary{cursor:pointer;font-weight:600}.pg-code{font-family:ui-monospace,Consolas,monospace;background:" + BG + ";border-radius:4px;padding:1px 5px}",
  "@media (max-width:430px){.pg-root{padding:8px}.pg-seat{grid-template-columns:18px minmax(0,1fr) auto}.pg-rule{grid-template-columns:24px minmax(0,1fr)}.pg-rule .pg-select,.pg-rule-locked,.pg-textarea{grid-column:2}}",
].join("\n");
