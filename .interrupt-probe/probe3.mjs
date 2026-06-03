// Probe 3: the actual user concern — a SUBAGENT (Task tool) launched in the
// turn that spawns a long-lived BACKGROUND process. Does interrupting the main
// turn kill the subagent's detached background child?
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'

const DIR='/storage/home/zhiningjiao/code/nanocode/.interrupt-probe'
const PIDFILE=`${DIR}/marker3.pid`, DONEFILE=`${DIR}/marker3.done`
for(const f of [PIDFILE,DONEFILE]){try{rmSync(f)}catch{}}

const userText = [
  'Use the Task tool to launch ONE subagent with subagent_type "general-purpose".',
  'Give the subagent EXACTLY this instruction (do it yourself, do not ask me anything):',
  `"Run this single bash command verbatim: bash ${DIR}/sleeper.sh ${PIDFILE} ${DONEFILE}  — then run: sleep 60  — then report the word DONE."`,
].join('\n')

const launchArgs=['--print','--output-format=stream-json','--verbose','--include-partial-messages','--dangerously-skip-permissions',`--session-id=${crypto.randomUUID()}`,'--',userText]
const sq=(s)=>`'${String(s).replace(/'/g,`'\\''`)}'`
const launchCmd=`claude ${launchArgs.map(sq).join(' ')}`
const STRIP=new Set(['CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_EXECPATH','CLAUDE_CODE_TMPDIR','AI_AGENT'])
const env={};for(const[k,v]of Object.entries(process.env))if(!STRIP.has(k))env[k]=v

const proc=spawn('bash',['-lc',launchCmd],{cwd:DIR,env,stdio:['ignore','pipe','pipe']})
console.log(`[probe3] bash child pid=${proc.pid}`)
proc.stdout.on('data',(c)=>{for(const l of c.toString().split('\n')){const t=l.trim();if(!t)continue;try{const e=JSON.parse(t);if(e.type)process.stdout.write(`[evt] ${e.type}/${e.subtype||''}\n`)}catch{}}})
proc.stderr.on('data',(c)=>process.stderr.write(`[stderr] ${c}`))
proc.on('exit',(code,sig)=>console.log(`[probe3] bash child exit code=${code} sig=${sig}`))

const start=Date.now()
const tick=setInterval(()=>{
  if(existsSync(PIDFILE)){
    clearInterval(tick)
    const mp=readFileSync(PIDFILE,'utf8').trim()
    let before='';try{before=execSync(`ps -o pid=,ppid=,pgid=,sid=,stat=,comm= -p ${mp}`).toString().trim()}catch{before='GONE'}
    console.log(`[probe3] marker pid=${mp} launched after ${((Date.now()-start)/1000).toFixed(1)}s\n[probe3] before:\n${before}`)
    setTimeout(()=>{
      console.log(`[probe3] >>> SIGINT to bash child pid=${proc.pid}`)
      try{proc.kill('SIGINT')}catch(e){console.log('killerr',e.message)}
      setTimeout(()=>{
        let after='';try{after=execSync(`ps -o pid=,ppid=,pgid=,sid=,stat=,comm= -p ${mp} 2>/dev/null||echo GONE`).toString().trim()}catch{after='GONE(psfail)'}
        console.log(`[probe3] after interrupt:\n${after}`)
        console.log(`[probe3] DONE marker-survived=${after!=='GONE'&&!after.includes('GONE')}`)
        try{execSync(`kill -TERM ${mp} 2>/dev/null`)}catch{}
        process.exit(0)
      },3000)
    },800)
  } else if(Date.now()-start>110000){clearInterval(tick);console.log('[probe3] TIMEOUT (subagent never launched marker)');proc.kill('SIGKILL');process.exit(1)}
},300)
