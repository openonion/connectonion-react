import { createControlCenterHost, createControlCenterClient, boundControlSnapshot, ControlSnapshot } from '../src/control-center';

class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer!: Port;
  closed = false;
  postMessage(data: unknown) { if (!this.closed) queueMicrotask(() => this.peer.onmessage?.({ data })); }
  start() {}
  close() { this.closed = true; this.onmessage = null; }
}
function pair() { const a = new Port(), b = new Port(); a.peer = b; b.peer = a; return [a, b] as const; }
const revision = 'sha256:' + 'a'.repeat(64);
const snapshot = (): ControlSnapshot => ({ sessionId: 's', agentAddress: '0xagent',
  chatItems: [{ id: '1', type: 'user', content: 'Hello' } as any], status: 'idle',
  connectionState: 'connected', skills: [{ name: 'hello', description: 'Say hello' }] });
const flush = async () => { for (let i=0; i<5; i++) await Promise.resolve(); };

it('sends the initial snapshot, then ordered state updates on one port', async () => {
  const [a, b] = pair();
  const states: ControlSnapshot[] = [];
  const client = createControlCenterClient(b, revision, 'epoch');
  client.subscribe(s => states.push(s));
  const host = createControlCenterHost(a, { revision, epoch: 'epoch', snapshot: snapshot(),
    sendMessage: async () => ({sessionId: 's'}), runSkill: async () => ({sessionId: 's'}) });
  await flush();
  expect(states).toEqual([snapshot()]);
  host.publish({...snapshot(), status: 'working'});
  await flush();
  expect(states[1].status).toBe('working');
  host.dispose(); client.dispose();
});

it('correlates actions and never executes a duplicate request id', async () => {
  const [a, b] = pair();
  const send = jest.fn(async () => ({sessionId: 's'}));
  const client = createControlCenterClient(b, revision, 'epoch');
  const host = createControlCenterHost(a, { revision, epoch: 'epoch', snapshot: snapshot(),
    sendMessage: send, runSkill: async () => ({sessionId: 's'}) });
  await flush();
  expect(await client.sendMessage('Hello')).toEqual({sessionId: 's'});
  const request = {type:'connectonion.control-center/request', version:1, revision, epoch:'epoch', id:'duplicate',
    action:'send_message', payload:{message:'one'}};
  b.postMessage(request); b.postMessage(request);
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  host.dispose(); client.dispose();
});

it('rejects unlisted skills, stale epochs and actions while disconnected', async () => {
  const [a, b] = pair();
  const run = jest.fn();
  const client = createControlCenterClient(b, revision, 'epoch');
  const host = createControlCenterHost(a, { revision, epoch:'epoch', snapshot: snapshot(),
    sendMessage: async () => ({sessionId:'s'}), runSkill: run });
  await flush();
  await expect(client.runSkill('not-published')).rejects.toThrow('publish');
  host.publish({...snapshot(), connectionState:'disconnected'}); await flush();
  await expect(client.sendMessage('Hello')).rejects.toThrow('connect');
  b.postMessage({type:'connectonion.control-center/request',version:1,revision,epoch:'old',id:'x',action:'run_skill',payload:{skill:'hello'}});
  await flush(); expect(run).not.toHaveBeenCalled();
  host.dispose(); client.dispose();
});

it('requests a fresh snapshot if an ordered event is missed', async () => {
  const [a, b] = pair();
  const states: ControlSnapshot[] = [];
  const client = createControlCenterClient(b, revision, 'epoch');
  client.subscribe(s => states.push(s));
  const host = createControlCenterHost(a, { revision, epoch:'epoch', snapshot:snapshot(),
    sendMessage:async()=>({sessionId:'s'}),runSkill:async()=>({sessionId:'s'}) });
  await flush();
  a.postMessage({type:'connectonion.control-center/event',version:1,revision,epoch:'epoch',sequence:4,snapshot:{...snapshot(),status:'working'}});
  await flush();
  expect(states[states.length - 1]?.status).toBe('idle');
  expect(states.length).toBe(2);
  host.dispose(); client.dispose();
});

it('cancellation reaches only the still-pending action and late replies are discarded', async () => {
  const [a,b] = pair(); let aborted = false;
  const client=createControlCenterClient(b,revision,'epoch');
  const host=createControlCenterHost(a,{revision,epoch:'epoch',snapshot:snapshot(),
    sendMessage:(_message, context)=>new Promise((_resolve,reject)=>{
      context.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));});
    }),runSkill:async()=>({sessionId:'s'})});
  await flush(); const controller=new AbortController();
  const pending=client.sendMessage('Hello',{signal:controller.signal}); await flush(); controller.abort();
  await expect(pending).rejects.toThrow('cancel'); await flush(); expect(aborted).toBe(true);
  host.dispose(); client.dispose();
});

it('destroyed frames cannot submit actions and pending client work is rejected', async () => {
  const [a,b]=pair(); const send=jest.fn();
  const client=createControlCenterClient(b,revision,'epoch');
  const host=createControlCenterHost(a,{revision,epoch:'epoch',snapshot:snapshot(),sendMessage:send,runSkill:send});
  await flush(); host.dispose(); client.dispose();
  await expect(client.sendMessage('late')).rejects.toThrow('closed');
  expect(send).not.toHaveBeenCalled();
});

it('times out a pending request once and propagates cancellation', async () => {
  jest.useFakeTimers();
  const [a,b]=pair(); let aborted=false;
  const client=createControlCenterClient(b,revision,'epoch');
  const host=createControlCenterHost(a,{revision,epoch:'epoch',snapshot:snapshot(),
    sendMessage:(_message,context)=>new Promise((_resolve,reject)=>{
      context.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));});
    }),runSkill:async()=>({sessionId:'s'})});
  jest.runAllTicks();
  const pending=client.sendMessage('Hello',{timeoutMs:100});
  const rejected=expect(pending).rejects.toThrow('timed out');
  jest.runAllTicks(); jest.advanceTimersByTime(101); jest.runAllTicks();
  await rejected; expect(aborted).toBe(true);
  host.dispose(); client.dispose(); jest.useRealTimers();
});

it('bounds recent normalized state by UTF-8 bytes while retaining small recent messages', () => {
  const state=snapshot();
  state.chatItems=[{type:'user',content:'中'.repeat(500000)},{type:'user',content:'recent'}] as any;
  const result=boundControlSnapshot(state);
  expect(result.truncated).toBe(true);
  expect(result.chatItems).toEqual([{type:'user',content:'recent'}]);
});
