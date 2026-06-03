#!/bin/bash
# Test the self-resume shell loop with fake claude stubs

QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

log() { echo "[QA] $*"; }
pass() { log "PASS: $1"; ((PASS++)); }
fail() { log "FAIL: $1"; ((FAIL++)); }

# ── Test 1: dead-loop prevention when --continue exits quickly ─────────────
log "Test 1: quick-exit --continue → stop looping"

# Make a fake 'claude' that:
#   - first call: runs for 0.3s (normal session)
#   - subsequent calls: exits instantly (no session)
CALL_COUNT_FILE="$QA_DIR/call-count.txt"
echo 0 > "$CALL_COUNT_FILE"

cat > "$QA_DIR/claude-stub1.sh" << 'EOF'
#!/bin/bash
QA_DIR="$(dirname "$(readlink -f "$0")")"
COUNT=$(cat "$QA_DIR/call-count.txt" 2>/dev/null || echo 0)
echo "$((COUNT+1))" > "$QA_DIR/call-count.txt"
if [ "$COUNT" = "0" ]; then
  sleep 0.3   # First call: simulate normal run
else
  exit 0      # Subsequent: exit instantly (no session)
fi
EOF
chmod +x "$QA_DIR/claude-stub1.sh"

# Run the loop script with a PATH that uses our stub
export PATH="$QA_DIR:$PATH"
cp "$QA_DIR/claude-stub1.sh" "$QA_DIR/claude"

# Build the same shell script the server generates
LOOP_SCRIPT='set +H; _cbr_first=1; _cbr_continue() {   while true; do     if [ "$_cbr_first" = "1" ]; then       _cbr_first=0;       claude --dangerously-skip-permissions;     else       _cbr_start=$SECONDS;       claude --continue --dangerously-skip-permissions;       _cbr_elapsed=$(( SECONDS - _cbr_start ));       if [ "$_cbr_elapsed" -lt 2 ]; then         echo "[nanocode] claude --continue failed quickly (no session?), dropping to bash";         break;       fi;     fi;     echo "";     echo "[nanocode] Claude exited. Press any key within 3s to stay in bash, or wait to auto-resume...";     _cbr_key="";     read -r -s -n 1 -t 3 _cbr_key;     if [ -n "$_cbr_key" ]; then       echo "[nanocode] Dropping to bash (key pressed).";       break;     fi;     echo "[nanocode] Auto-resuming...";   done; }; _cbr_continue; echo "REACHED_BASH"'

# Run with timeout (max 10s); when --continue exits immediately it should break out
OUTPUT=$(timeout 10s bash -c "$LOOP_SCRIPT" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 124 ]; then
  fail "Test 1: TIMEOUT — loop didn't break out (dead loop!)"
elif echo "$OUTPUT" | grep -q "claude --continue failed quickly"; then
  pass "Test 1: quick-exit --continue detected, loop broke correctly"
elif echo "$OUTPUT" | grep -q "REACHED_BASH"; then
  pass "Test 1: loop exited and reached bash (dead-loop prevention OK)"
else
  fail "Test 1: Unexpected output: $(echo "$OUTPUT" | head -5)"
fi

log "Test 1 output: $(echo "$OUTPUT" | tr '\n' '|' | head -c 200)"

# ── Test 2: disabled setting falls back to single-shot ──────────────────────
log "Test 2: disabled = single-shot only"
SIMPLE='claude --dangerously-skip-permissions; exec bash -l'
# The simple version should exit quickly without looping
OUTPUT2=$(timeout 5s bash -c "$SIMPLE; echo REACHED_BASH" 2>&1)
EXIT2=$?
if [ $EXIT2 -eq 124 ]; then
  fail "Test 2: timeout"
else
  pass "Test 2: single-shot mode exits correctly"
fi

# ── Test 3: 3s countdown — no keypress → auto-resume attempt ───────────────
log "Test 3: no keypress → auto-resume triggered (uses quick-exit stub)"
# This test: first call normal, second exits instantly → loop breaks after 3s wait
echo 0 > "$CALL_COUNT_FILE"
OUTPUT3=$(echo "" | timeout 8s bash -c "$LOOP_SCRIPT" 2>&1)
EXIT3=$?
if [ $EXIT3 -eq 124 ]; then
  fail "Test 3: timeout (>8s) — loop stuck"
else
  if echo "$OUTPUT3" | grep -q "Auto-resuming"; then
    pass "Test 3: auto-resume triggered after countdown"
  elif echo "$OUTPUT3" | grep -q "claude --continue failed quickly"; then
    pass "Test 3: auto-resume triggered then quick-exit caught (dead-loop prevention)"
  else
    fail "Test 3: Expected auto-resume message, got: $(echo "$OUTPUT3" | tr '\n' '|' | head -c 200)"
  fi
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────
rm -f "$QA_DIR/claude" "$QA_DIR/claude-stub1.sh" "$QA_DIR/call-count.txt"
log "=== Results: PASS=$PASS FAIL=$FAIL ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1
