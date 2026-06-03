## feat: live-apply tool-fold + subagent toggles on change (no Save needed)

### What changed
- `public/js/app.js`: Added `change` event listeners to the 3 `input[name="tool-fold"]` radios and the 2 subagent visibility checkboxes.
- Each `change` fires `setToolFoldLevel(value)` / `setSubagentPromptVisible(checked)` / `setSubagentActivityVisible(checked)` immediately — no Save click needed.
- Save buttons are preserved (still call the same setters + show "Saved" feedback).
- Existing `loadToolFoldSettings()` / `loadSubagentVisSettings()` already correctly restore stored state on panel open — no change needed.

### Verification
- `node --check public/js/app.js` → SYNTAX OK
- `npm test` → 6/6 pass, # fail 0
- Playwright live test (correct localStorage keys): ALL PASS
  - radio change → full → cbr_tool_fold = 'full' (no Save)
  - radio change → line → cbr_tool_fold = 'line' (no Save)
  - subagent-prompt uncheck → cbr_subagent_prompt = 'false' (no Save)
  - subagent-activity check → cbr_subagent_activity = 'true' (no Save)
  - change→line persistence: cbr_tool_fold = 'line' ✓

### Commit
(see git log)
