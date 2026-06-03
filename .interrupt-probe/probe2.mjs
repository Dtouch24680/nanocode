// Probe 2: realistic worry — a Bash tool command running in the FOREGROUND of
// the turn (no nohup/&), which spawns a child. When we SIGINT the bash->claude
// child, does claude propagate SIGINT to its own foreground Bash-tool subprocess?
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

const DIR = '/storage/home/zhiningjiao/code/nanocode/.interrupt-probe'
const PIDFILE = `${DIR}/marker2.pid`
const DONEFILE = `${DIR}/marker2.done`
for (const f of [PIDFILE, DONEFILE]) { try { rmSync(f) } catch {} }

// Foreground long-running bash command. The turn stays busy *inside* this Bash
// tool call (claude is waiting on the child to finish).
const userText = [
  'Run exactly this one bash command (it will take a while, just wait for it):',
  `bash -c 'echo $$ > ${PIDFILE}; for i in $(seq 1 40); do sleep 1; done; echo finished > ${DONEFILE}'`,
].join('\n')

const launchArgs = [
  '--print','--output-format=stream-json','--verbose','--include-partial-messages',
  '--dangerously-skip-permissions', `--session-id=${crypto.randomUUID()}`, '--', userText,
]
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const launchCmd = `claude ${launchArgs.map(sq).join(' ')}`
const STRIP = new Set(['CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_EXECPATH','CLAUDE_CODE_TMPDIR','AI_AGENT'])
const env = {}; for (const [k,v] of Object.entries(process.env)) if (!STRIP.has(k)) env[k]=v

const proc = spawn('bash', ['-lc', launchCmd], { cwd: DIR, env, stdio: ['ignore','pipe','pipe'] })
console.log(`[probe2] bash child pid=${proc.pid} pgid=${(()=>{try{return execSync('ps -o pgid= -p '+proc.pid).toString().trim()}catch{return '?'}})()}`)
proc.stdout.on('data',(c)=>{for(const l of c.toString().split('\n')){const t=l.trim();if(!t)continue;try{const e=JSON.parse(t);if(e.type)process.stdout.write(`[evt] ${e.type}/${e.subtype||''}\n`)}catch{}}})
proc.stderr.on('data',(c)=>process.stderr.write(`[stderr] ${c}`))
proc.on('exit',(code,sig)=>console.log(`[probe2] bash child exit code=${code} sig=${sig}`))

const start=Date.now()
const tick=setInterval(()=>{
  if(existsSync(PIDFILE)){
    clearInterval(tick)
    const mp=readFileSync(PIDFILE,'utf8').trim()
    let before=''; try{before=execSync(`ps -o pid=,ppid=,pgid=,stat=,comm= -p ${mp}`).toString().trim()}catch{before='GONE'}
    console.log(`[probe2] marker pid=${mp} launched after ${((Date.now()-start)/1000).toFixed(1)}s\n[probe2] before:\n${before}`)
    setTimeout(()=>{
      console.log(`[probe2] >>> SIGINT to bash child pid=${proc.pid}`)
      try{proc.kill('SIGINT')}catch(e){console.log('killerr',e.message)}
      setTimeout(()=>{
        let after=''; try{after=execSync(`ps -o pid=,ppid=,pgid=,stat=,comm= -p ${mp} 2>/dev/null||echo GONE`).toString().trim()}catch{after='GONE(psfail)'}
        console.log(`[probe2] after interrupt:\n${after}`)
        console.log(`[probe2] DONE done-file-exists=${existsSync(DONEFILE)}`)
        try{execSync(`kill -TERM ${mp} 2>/dev/null`)}catch{}
        process.exit(0)
      },2500)
    },800)
  } else if(Date.now()-start>90000){clearInterval(tick);console.log('[probe2] TIMEOUT');proc.kill('SIGKILL');process.exit(1)}
},300)
