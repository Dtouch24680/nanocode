// Probe 4: verify detached:true + single-pid kill('SIGINT') still interrupts the
// main claude turn correctly (turn ends with SIGINT), AND a detached subagent
// background child still survives. This validates the proposed nanocode change.
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

const DIR='/storage/home/zhiningjiao/code/nanocode/.interrupt-probe'
const PIDFILE=`${DIR}/marker4.pid`, DONEFILE=`${DIR}/marker4.done`
for(const f of [PIDFILE,DONEFILE]){try{rmSync(f)}catch{}}

const userText=[
  `First run this single bash command verbatim: bash ${DIR}/sleeper.sh ${PIDFILE} ${DONEFILE}`,
  'Then run: sleep 40. Then say DONE.',
].join('\n')
const launchArgs=['--print','--output-format=stream-json','--verbose','--include-partial-messages','--dangerously-skip-permissions',`--session-id=${crypto.randomUUID()}`,'--',userText]
const sq=(s)=>`'${String(s).replace(/'/g,`'\\''`)}'`
const launchCmd=`claude ${launchArgs.map(sq).join(' ')}`
const STRIP=new Set(['CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_EXECPATH','CLAUDE_CODE_TMPDIR','AI_AGENT'])
const env={};for(const[k,v]of Object.entries(process.env))if(!STRIP.has(k))env[k]=v

// THE CHANGE UNDER TEST: detached:true
const proc=spawn('bash',['-lc',launchCmd],{cwd:DIR,env,stdio:['ignore','pipe','pipe'],detached:true})
console.log(`[probe4] bash child pid=${proc.pid} (detached:true, own pgid)`)
let interrupted=false
proc.stdout.on('data',(c)=>{for(const l of c.toString().split('\n')){const t=l.trim();if(!t)continue;try{const e=JSON.parse(t);if(e.type&&!['stream_event','rate_limit_event'].includes(e.type))process.stdout.write(`[evt] ${e.type}/${e.subtype||''}\n`)}catch{}}})
proc.stderr.on('data',(c)=>process.stderr.write(`[stderr] ${c}`))
proc.on('exit',(code,sig)=>console.log(`[probe4] bash child exit code=${code} sig=${sig} (turn interrupted cleanly=${interrupted})`))

const start=Date.now()
const tick=setInterval(()=>{
  if(existsSync(PIDFILE)){
    clearInterval(tick)
    const mp=readFileSync(PIDFILE,'utf8').trim()
    let before='';try{before=execSync(`ps -o pid=,ppid=,pgid=,sid=,stat= -p ${mp}`).toString().trim()}catch{before='GONE'}
    console.log(`[probe4] marker pid=${mp} after ${((Date.now()-start)/1000).toFixed(1)}s\n[probe4] before: ${before}`)
    setTimeout(()=>{
      interrupted=true
      console.log(`[probe4] >>> SIGINT to single pid ${proc.pid} (positive pid, not group)`)
      try{proc.kill('SIGINT')}catch(e){console.log('killerr',e.message)}
      setTimeout(()=>{
        let after='';try{after=execSync(`ps -o pid=,ppid=,pgid=,sid=,stat= -p ${mp} 2>/dev/null||echo GONE`).toString().trim()}catch{after='GONE(psfail)'}
        const survived=after!=='GONE'&&!after.includes('GONE')
        console.log(`[probe4] marker after: ${after}\n[probe4] DONE marker-survived=${survived}`)
        try{execSync(`kill -TERM ${mp} 2>/dev/null`)}catch{}
        process.exit(0)
      },3000)
    },800)
  } else if(Date.now()-start>90000){clearInterval(tick);console.log('[probe4] TIMEOUT');try{process.kill(-proc.pid,'SIGKILL')}catch{};process.exit(1)}
},300)
