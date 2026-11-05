import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../app/chatgpt-auth';
import { initialState, applyAction, summarize, DomainError, expire } from './engine.mjs';
export async function identity(){const user=await getChatGPTUser();if(!user)throw new DomainError('UNAUTHENTICATED','Sign in to save your demo sessions.',401);return user;}
export async function workspace(){const user=await identity();if(!env.DB)throw new DomainError('STORAGE_UNAVAILABLE','Demo storage is temporarily unavailable.',503);await env.DB.prepare('INSERT OR IGNORE INTO demo_workspaces (owner_id, version, state, updated_at) VALUES (?, 0, ?, ?)').bind(user.userId,JSON.stringify(initialState()),new Date().toISOString()).run();return {user,db:env.DB};}
export async function readState(){
 const {user,db}=await workspace();
 for(let attempt=0;attempt<8;attempt++){
  const row=await db.prepare('SELECT state, version FROM demo_workspaces WHERE owner_id = ?').bind(user.userId).first<{state:string,version:number}>();
  const now=Date.now();const state=expire(JSON.parse(row!.state),now);const serialized=JSON.stringify(state);
  if(serialized!==row!.state){
   const write=await db.prepare('UPDATE demo_workspaces SET state = ?, version = version + 1, updated_at = ? WHERE owner_id = ? AND version = ?').bind(serialized,new Date(now).toISOString(),user.userId,row!.version).run();
   if(write.meta.changes!==1)continue;
  }
  return {...summarize(state,now),viewer:{name:user.displayName||'You'}};
 }
 throw new DomainError('CONCURRENT_UPDATE','The workspace is busy. Please retry.',409);
}
export async function mutate(action:string,payload:Record<string,unknown>,key:string){const {user,db}=await workspace();for(let attempt=0;attempt<8;attempt++){const row=await db.prepare('SELECT state, version FROM demo_workspaces WHERE owner_id = ?').bind(user.userId).first<{state:string,version:number}>();const changed=applyAction(JSON.parse(row!.state),action,payload,key);const write=await db.prepare('UPDATE demo_workspaces SET state = ?, version = version + 1, updated_at = ? WHERE owner_id = ? AND version = ?').bind(JSON.stringify(changed.state),new Date().toISOString(),user.userId,row!.version).run();if(write.meta.changes===1)return {state:{...summarize(changed.state),viewer:{name:user.displayName||'You'}},result:changed.result};}throw new DomainError('CONCURRENT_UPDATE','Another request is being saved. Please try again.',409);}
export function errorResponse(error:unknown){if(error instanceof DomainError)return Response.json({error:{code:error.code,message:error.message}},{status:error.status});console.error('Request failed',error instanceof Error?error.name:'Unknown');return Response.json({error:{code:'SERVER_ERROR',message:'Something went wrong. Please try again.'}},{status:500});}
