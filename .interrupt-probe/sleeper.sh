#!/usr/bin/env bash
# Self-detaching long-lived marker process. Writes its own PID, sleeps, then
# writes a done file. Used to test whether it survives a main-turn interrupt.
PIDFILE="$1"
DONEFILE="$2"
setsid bash -c '
  echo $$ > "'"$PIDFILE"'"
  for i in $(seq 1 90); do sleep 1; done
  echo finished > "'"$DONEFILE"'"
' >/dev/null 2>&1 < /dev/null &
disown
echo "launched marker, pidfile=$PIDFILE"
