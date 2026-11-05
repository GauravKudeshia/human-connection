import {initialState,applyAction,expire,summarize} from '../lib/engine.mjs';

// A visitor's sessionStorage is isolated by tab. No business data goes over the network.
export function makeBrowserRequest(storage, key) {
  let memory = initialState();
  function read() {
    const raw = storage?.getItem(key);
    if (!raw) return structuredClone(memory);
    const state = JSON.parse(raw);
    if (state.schema !== 1 || !Array.isArray(state.bookings)) throw new Error('Cannot read this demo session. Open a new tab.');
    return state;
  }
  function save(state) {
    if(storage) storage.setItem(key,JSON.stringify(state));
    memory = state;
  }
  function view(state) { return {...summarize(state),viewer:{name:'Demo guest'}}; }
  return async (path,options={}) => {
    try {
      const current=read();
      if(path==='/api/state'&&(!options.method||options.method==='GET')) {
        const before=JSON.stringify(current);expire(current,Date.now());if(JSON.stringify(current)!==before)save(current);
        return Response.json(view(current));
      }
      if(path!=='/api/action'||options.method!=='POST')return Response.json({error:{message:'Unknown demo action.'}},{status:404});
      const {action,payload}=JSON.parse(options.body);
      const {state,result}=applyAction(current,action,payload,new Headers(options.headers).get('Idempotency-Key'));
      // Replay keys retain the payload for server retries. The tab never replays network writes;
      // remove old narrative-bearing keys when this local-only account is closed.
      if(action==='close-account')state.idempotency={};
      save(state);return Response.json({state:view(state),result});
    } catch(error) {return Response.json({error:{message:error.message||'Unable to open this demo tab.'}},{status:error.status||400});}
  };
}
