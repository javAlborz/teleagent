'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {OwnerDecisionRouter} = require('../lib/owner-decision-router');
const decision={instructions:'Interpret the caller.',input:[{role:'user',content:[{type:'input_text',text:'Read drizzy'}]}],
  tools:[{name:'route_turn',description:'One decision',parameters:{type:'object',properties:{action:{type:'string'}},required:['action']}}]};
const valid={id:'resp-test',model:'gpt-6-luna',status:'completed',output:[{type:'function_call',name:'route_turn',call_id:'call-test',arguments:'{"action":"respond"}'}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
function fixture({status=200,value=valid,raw,hang=false,timeoutMs=1000}={}) {
  const seen={}; const createConnection=()=>{throw new Error('No actual sockets in this unit test');};
  const request=(options, callback)=>{
    seen.options=options;const req=new EventEmitter();
    req.destroy=error=>queueMicrotask(()=>req.emit('error',error));
    options.signal?.addEventListener('abort',()=>req.destroy(new Error('aborted')),{once:true});
    req.end=body=>{
      seen.body=JSON.parse(body);
      if(hang)return;
      queueMicrotask(()=>{
        const response=new EventEmitter();response.statusCode=status;callback(response);
        response.emit('data',Buffer.from(raw===undefined?JSON.stringify(value):raw));response.emit('end');
      });
    };
    return req;
  };
  return {seen,createConnection,router:new OwnerDecisionRouter({apiKey:'fixture-secret',project:'fixture-project',request,
    connectionOptions:()=>({createConnection}),timeoutMs})};
}

test('decision API is fixed to OpenAI over the admitted Unix TLS connector and has no executable tools', async()=>{
  const f=fixture();const result=await f.router.decide(decision);
  assert.equal(result.calls.length,1);assert.deepEqual(result.usage,valid.usage);
  assert.equal(f.seen.options.hostname,'api.openai.com');assert.equal(f.seen.options.path,'/v1/responses');
  assert.equal(f.seen.options.agent.createConnection,f.createConnection);
  assert.equal(f.seen.body.model,'gpt-6-luna');assert.equal(f.seen.body.store,false);
  assert.equal(f.seen.body.parallel_tool_calls,false);assert.equal(f.seen.body.tools.length,1);
  assert.equal(f.seen.body.tools[0].name,'route_turn');assert.equal(f.seen.body.reasoning.effort,'medium');
  assert.equal(JSON.stringify(result).includes('fixture-secret'),false);
});

test('redirects, provider errors, malformed and incomplete decisions fail without executable output',async()=>{
  for(const options of [{status:302},{status:403},{status:429},{raw:'{bad'},
    {value:{...valid,status:'incomplete'}},{value:{...valid,output:[]}},
    {value:{...valid,output:[...valid.output,...valid.output]}},
    {value:{...valid,output:[{type:'function_call',name:'shell',arguments:'{}'}]}}]) {
    await assert.rejects(fixture(options).router.decide(decision),/OWNER_DECISION_/);
  }
});

test('oversized context and responses are bounded before interpretation',async()=>{
  await assert.rejects(fixture().router.decide({...decision,instructions:'x'.repeat(128*1024)}),/CONTEXT_TOO_LARGE/);
  await assert.rejects(fixture({raw:'x'.repeat(256*1024+1)}).router.decide(decision),/OWNER_DECISION_/);
});

test('a caller cancellation and the absolute deadline terminate a pending decision',async()=>{
  const abort=new AbortController();const f=fixture({hang:true});
  const pending=f.router.decide(decision,{signal:abort.signal});abort.abort();
  await assert.rejects(pending,/ABORTED/);
  await assert.rejects(fixture({hang:true,timeoutMs:10}).router.decide(decision),/REQUEST_FAILED/);
});

test('a missing admitted connector cannot fall back to a normal network agent',async()=>{
  let requested=false;
  const router=new OwnerDecisionRouter({apiKey:'fixture-secret',connectionOptions:()=>({}),request:()=>{requested=true;}});
  await assert.rejects(router.decide(decision),/EGRESS_UNAVAILABLE/);assert.equal(requested,false);
});
