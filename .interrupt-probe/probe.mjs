// Replicates nanocode's exact spawn: spawn('bash', ['-lc', 'claude --print ...'])
// then sends SIGINT to the bash child (as routes.js interrupt does) and reports
// whether a child process the turn spawned survives.
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

const DIR = '/storage/home/zhiningjiao/code/nanocode/.interrupt-probe'
const PIDFILE = `${DIR}/marker.pid`
const DONEFILE = `${DIR}/marker.done`
for (const f of [PIDFILE, DONEFILE]) { try { rmSync(f) } catch {} }

// Prompt: tell claude to launch a background sleeper that records its PID, then
// keep itself busy so the turn is still running when we SIGINT.
const userText = [
  'Run exactly this bash command and nothing else, then tell me you are done:',
  `nohup bash -c 'echo $$ > ${PIDFILE}; for i in $(seq 1 60); do sleep 1; done; echo finished > ${DONEFILE}' >/dev/null 2>&1 &`,
  'After launching it, wait by running: sleep 30',
].join('\n')

const launchArgs = [
  '--print', '--output-format=stream-json', '--verbose',
  '--include-partial-messages', '--dangerously-skip-permissions',
  `--session-id=${crypto.randomUUID()}`, '--', userText,
]
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const launchCmd = `claude ${launchArgs.map(sq).join(' ')}`

const STRIP = new Set(['CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_EXECPATH','CLAUDE_CODE_TMPDIR','AI_AGENT'])
const env = {}
for (const [k,v] of Object.entries(process.env)) if (!STRIP.has(k)) env[k]=v

const proc = spawn('bash', ['-lc', launchCmd], { cwd: DIR, env, stdio: ['ignore','pipe','pipe'] })
console.log(`[probe] bash child pid=${proc.pid}`)

proc.stdout.on('data', (c) => {
  for (const line of c.toString().split('\n')) {
    const t = line.trim(); if (!t) continue
    try { const e = JSON.parse(t); if (e.type) process.stdout.write(`[evt] ${e.type}/${e.subtype||''}\n`) } catch {}
  }
})
proc.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c}`))
proc.on('exit', (code, sig) => console.log(`[probe] bash child exit code=${code} sig=${sig}`))

// Wait until the marker pid file appears (subprocess launched), then SIGINT.
const start = Date.now()
const tick = setInterval(() => {
  if (existsSync(PIDFILE)) {
    clearInterval(tick)
    const markerPid = readFileSync(PIDFILE,'utf8').trim()
    console.log(`[probe] marker subprocess pid=${markerPid} launched after ${((Date.now()-start)/1000).toFixed(1)}s`)
    setTimeout(() => {
      console.log(`[probe] >>> sending SIGINT to bash child pid=${proc.pid} (mimics routes.js interrupt)`)
      try { proc.kill('SIGINT') } catch (e) { console.log('kill err', e.message) }
      // Inspect after the dust settles.
      setTimeout(() => {
        try {
          const out = execSync(`ps -o pid=,ppid=,pgid=,stat=,comm= -p ${markerPid} 2>/dev/null || echo GONE`).toString().trim()
          console.log(`[probe] marker pid=${markerPid} after interrupt:\n${out}`)
        } catch { console.log(`[probe] marker pid=${markerPid} GONE (ps failed)`) }
        console.log('[probe] DONE')
        process.exit(0)
      }, 2500)
    }, 800)
  } else if (Date.now()-start > 90000) {
    clearInterval(tick); console.log('[probe] TIMEOUT waiting for marker'); proc.kill('SIGKILL'); process.exit(1)
  }
}, 300)
