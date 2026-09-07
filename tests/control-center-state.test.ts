import { RemoteAgent } from '../src/connect/remote-agent';
const revision = 'sha256:' + 'a'.repeat(64);
const receive = (agent: any, frame: unknown) => agent._handleMessage({data:JSON.stringify(frame)});
const app = {schema:'connectonion.control-app/1',revision,url:'https://app.test/',sdk_version:'1',review:{status:'approved'}};

it('accepts Control Center state only from the authenticated current session', () => {
  const agent = new RemoteAgent('0xagent', {wsCtor: class {} as any}) as any;
  agent._currentSession = {session_id:'ours'};
  const frame = {type:'CONTROL_CENTER_STATE',session_id:'ours',state:{schema:1,status:'approved',active:app,history:[],updates:{}}};
  receive(agent, frame);
  expect(agent.controlCenterState).toBeNull();
  agent._authenticated=true;
  receive(agent, {...frame,session_id:'other'});
  expect(agent.controlCenterState).toBeNull();
  receive(agent, frame);
  expect(agent.controlCenterState.active.revision).toBe(revision);
  receive(agent, {...frame,state:{...frame.state,status:'blocked'}});
  expect(agent.controlCenterState.status).toBe('blocked');
  expect(agent.controlCenterApp.revision).toBe(revision);
});

it('explicit unavailable state clears the active app while malformed data does not', () => {
  const agent = new RemoteAgent('0xagent', {wsCtor: class {} as any}) as any;
  agent._authenticated=true;agent._currentSession={session_id:'ours'};
  const frame={type:'CONTROL_CENTER_STATE',session_id:'ours',state:{schema:1,status:'approved',active:app,history:[],updates:{}}};
  receive(agent, frame);
  receive(agent, {...frame,state:{...frame.state,active:{...app,revision:'forged'}}});
  expect(agent.controlCenterApp.revision).toBe(revision);
  receive(agent, {...frame,state:{...frame.state,status:'unavailable',active:null}});
  expect(agent.controlCenterApp).toBeNull();
});

it('uses a signed correlated command and rejects a Host refusal', async () => {
  const agent = new RemoteAgent('0xagent', {wsCtor: class {} as any}) as any;
  agent._requestSessionFrame=jest.fn(async()=>({ok:true,result:{status:'accepted'}}));
  await expect(agent.controlCenterCommand('update')).resolves.toEqual({status:'accepted'});
  expect(agent._requestSessionFrame).toHaveBeenCalledWith({type:'CONTROL_CENTER_COMMAND',action:'update',payload:{}},['CONTROL_CENTER_RESULT']);
  agent._requestSessionFrame.mockResolvedValue({ok:false,error:{message:'administrator required'}});
  await expect(agent.controlCenterCommand('update')).rejects.toThrow('administrator');
});

it('rejects unauthenticated legacy descriptors and clears state on reset', () => {
  const agent = new RemoteAgent('0xagent', {wsCtor: class {} as any}) as any;
  agent._currentSession={session_id:'ours'};
  receive(agent,{type:'CONTROL_CENTER_APP',session_id:'ours',app});
  expect(agent.controlCenterApp).toBeNull();
  agent._authenticated=true;
  receive(agent,{type:'CONTROL_CENTER_STATE',session_id:'ours',state:{schema:1,status:'approved',active:app,history:[],updates:{}}});
  agent.reset();
  expect(agent.controlCenterState).toBeNull();
  expect(agent.controlCenterApp).toBeNull();
});

it('cancels before dispatch and never interrupts an unrelated running turn', async () => {
  const agent = new RemoteAgent('0xagent', {wsCtor: class {} as any}) as any;
  agent._status='working';
  const signal=new AbortController();
  await expect(agent.inputFromControlCenter('hello',signal.signal)).rejects.toThrow('busy');
  agent._status='idle';
  let connected!:()=>void;
  agent._ensureConnected=()=>new Promise<void>(resolve=>{connected=resolve});
  agent._sendAuthenticated=jest.fn();agent.interrupt=jest.fn();
  const pending=agent.inputFromControlCenter('hello',signal.signal);
  signal.abort();connected();
  await expect(pending).rejects.toThrow('cancel');
  expect(agent._sendAuthenticated).not.toHaveBeenCalled();
  expect(agent.interrupt).not.toHaveBeenCalled();
});

it('cancels a dispatched Control Center turn once, then removes the abort listener', async () => {
  const agent = new RemoteAgent('0xagent', {wsCtor: class {} as any}) as any;
  agent._ensureConnected=async()=>{};agent._sendAuthenticated=jest.fn();agent.interrupt=jest.fn();
  const signal=new AbortController();
  const pending=agent.inputFromControlCenter('hello',signal.signal);
  await Promise.resolve();
  signal.abort();
  expect(agent.interrupt).toHaveBeenCalledTimes(1);
  agent._inputResolve({text:'Stopped',done:true});await pending;
  expect(agent._sendAuthenticated).toHaveBeenCalledTimes(1);
});
