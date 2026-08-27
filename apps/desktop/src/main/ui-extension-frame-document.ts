export function uiExtensionFramePolicy(network: boolean): string {
  const networkPolicy = network
    ? "connect-src https: wss:; img-src data: blob: https:; media-src blob: https:; font-src data: https:;"
    : "connect-src 'none'; img-src data: blob:; media-src blob:; font-src data:;";
  return `default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ${networkPolicy}`;
}

export function withUiSandboxPolicy(
  document: string,
  network: boolean,
  bridgeToken?: string,
  declaredSlots: readonly string[] = [],
): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${uiExtensionFramePolicy(network)}">`;
  const sdkStyles = `<style data-maka-ui-sdk="1">${uiExtensionSdkStyles()}</style>`;
  const bridge = bridgeToken
    ? `<script>${bridgeBootstrap(bridgeToken, declaredSlots)}</script>`
    : '';
  const head = /^\s*(?:<!doctype[^>]*>\s*)?<html(?:\s[^>]*)?>\s*<head(?:\s[^>]*)?>/iu;
  if (head.test(document)) return document.replace(head, (match) => `${match}${policy}${sdkStyles}${bridge}`);
  return `<!doctype html><html><head>${policy}${sdkStyles}${bridge}</head><body>${document}</body></html>`;
}

export function uiExtensionSdkStyles(): string {
  return `:root{color-scheme:light dark;--maka-ui-bg:Canvas;--maka-ui-fg:CanvasText;--maka-ui-muted:GrayText;--maka-ui-accent:#6b5cff;--maka-ui-border:color-mix(in srgb,CanvasText 18%,transparent);--maka-ui-radius:10px;--maka-ui-space-1:4px;--maka-ui-space-2:8px;--maka-ui-space-3:12px;--maka-ui-space-4:16px;font:13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:transparent;color:var(--maka-ui-fg)}*{box-sizing:border-box}body{margin:0;background:transparent;color:inherit}.maka-ui-card{padding:var(--maka-ui-space-4);border:1px solid var(--maka-ui-border);border-radius:var(--maka-ui-radius);background:var(--maka-ui-bg)}.maka-ui-stack{display:flex;flex-direction:column;gap:var(--maka-ui-space-3)}.maka-ui-row{display:flex;align-items:center;gap:var(--maka-ui-space-2)}.maka-ui-button{min-height:32px;padding:6px 12px;border:1px solid var(--maka-ui-border);border-radius:8px;background:var(--maka-ui-bg);color:inherit;font:inherit}.maka-ui-button[data-variant=primary]{border-color:var(--maka-ui-accent);background:var(--maka-ui-accent);color:white}.maka-ui-muted{color:var(--maka-ui-muted)}`;
}

function bridgeBootstrap(token: string, declaredSlots: readonly string[]): string {
  return `(function(){
const token=${JSON.stringify(token)},declaredSlots=${JSON.stringify(declaredSlots)},pending=new Map(),subscriptions=new Map(),contextListeners=new Set(),queued=[];
let sequence=0,ready=false,layoutFrame=0,currentContext=null;
const announce=function(){if(!ready)parent.postMessage({channel:'maka-ui-bridge-ready/v1',token:token},'*');},retry=setInterval(announce,50);
function publishSlots(){layoutFrame=0;const slots=[];for(const name of declaredSlots){const element=document.querySelector('[data-maka-slot="'+CSS.escape(name)+'"]');if(!element)continue;const rect=element.getBoundingClientRect();slots.push({name:name,x:rect.x,y:rect.y,width:rect.width,height:rect.height});}parent.postMessage({channel:'maka-ui-slot-layout/v1',token:token,slots:slots},'*');}
function scheduleSlots(){if(!layoutFrame)layoutFrame=requestAnimationFrame(publishSlots);}
window.addEventListener('resize',scheduleSlots);window.addEventListener('scroll',scheduleSlots,true);
new MutationObserver(scheduleSlots).observe(document.documentElement,{attributes:true,childList:true,subtree:true});
if(typeof ResizeObserver==='function')new ResizeObserver(scheduleSlots).observe(document.documentElement);
window.addEventListener('keydown',function(event){if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key==='Backspace'){event.preventDefault();event.stopImmediatePropagation();const id=String(++sequence),envelope={channel:'maka-ui-bridge/v1',token:token,id:id,kind:'safe_mode'};ready?parent.postMessage(envelope,'*'):queued.push(envelope);}},true);
window.addEventListener('message',function(event){const data=event.data;if(event.source!==parent||!data||data.token!==token)return;if(data.channel==='maka-ui-context/v1'){currentContext=data.context;for(const listener of [...contextListeners])listener(currentContext);return;}if(data.channel==='maka-ui-host-ready/v1'){currentContext=data.context;for(const listener of [...contextListeners])listener(currentContext);if(ready)return;ready=true;clearInterval(retry);while(queued.length)parent.postMessage(queued.shift(),'*');scheduleSlots();return;}if(data.channel!=='maka-ui-host/v1')return;const task=pending.get(data.id);if(!task)return;pending.delete(data.id);data.ok?task.resolve(data.result):task.reject(new Error(data.error||'Host request failed'));});
function call(message){return new Promise(function(resolve,reject){const id=String(++sequence),envelope=Object.assign({channel:'maka-ui-bridge/v1',token,id},message);pending.set(id,{resolve,reject});ready?parent.postMessage(envelope,'*'):queued.push(envelope);});}
function subscribe(key,listener){if(typeof listener!=='function')throw new TypeError('UI state listener must be a function');let subscription=subscriptions.get(key);if(!subscription){subscription={cursor:0,listeners:new Set(),active:true};subscriptions.set(key,subscription);(async function pump(){while(subscription.active){try{const result=await call({kind:'events',key:key,afterSequence:subscription.cursor,waitMs:25000});subscription.cursor=result.sequence;for(const change of result.changes){for(const current of [...subscription.listeners])current(change.kind==='set'?change.value:undefined,change);}}catch(error){if(subscription.active)await new Promise(function(resolve){setTimeout(resolve,250);});}}})();}subscription.listeners.add(listener);return function(){subscription.listeners.delete(listener);if(subscription.listeners.size===0){subscription.active=false;subscriptions.delete(key);}};}
function agent(method,input){return call({kind:'agent_invoke',method:method,input:input===undefined?{}:input});}
function client(method,input){return call({kind:'client',method:method,input:input===undefined?{}:input});}
const agents=Object.freeze({invoke:agent,create:function(input){return agent('create',input);},resume:function(input){return agent('resume',input);},get:function(agentId){return agent('get',{agentId:agentId});},list:function(){return agent('list',{});},roots:function(){return agent('roots',{});},followup:function(agentId,input){return agent('agent.followup',Object.assign({},input,{agentId:agentId}));},steer:function(agentId,input){return agent('agent.steer',Object.assign({},input,{agentId:agentId}));},cancel:function(agentId,input){return agent('agent.cancel',Object.assign({},input,{agentId:agentId}));},whenIdle:function(agentId){return agent('agent.whenIdle',{agentId:agentId});},retract:function(agentId,input){return agent('agent.retract',Object.assign({},input,{agentId:agentId}));},receipt:function(agentId,input){return agent('agent.receipt',Object.assign({},input,{agentId:agentId}));},status:function(agentId){return agent('agent.status',{agentId:agentId});},session:function(agentId){return agent('agent.session',{agentId:agentId});},options:function(agentId){return agent('agent.options',{agentId:agentId});},inbox:function(agentId){return agent('agent.inbox',{agentId:agentId});},events:function(agentId,input){return agent('agent.events',Object.assign({},input,{agentId:agentId}));},result:function(agentId,input){return agent('agent.result',Object.assign({},input,{agentId:agentId}));},artifacts:function(agentId,input){return agent('agent.artifacts',Object.assign({},input,{agentId:agentId}));},usage:function(agentId,input){return agent('agent.usage',Object.assign({},input,{agentId:agentId}));},transcript:function(agentId,input){return agent('agent.transcript',Object.assign({},input,{agentId:agentId}));}});
const clientApi=Object.freeze({theme:function(){return client('theme');},navigate:function(route){return client('navigate',{route:route});},notify:function(message){return client('notify',{message:message});},confirm:function(message){return client('confirm',{message:message});},writeClipboard:function(text){return client('clipboard.write',{text:text});}});
Object.defineProperty(window,'makaUI',{value:Object.freeze({getConfig:function(){return call({kind:'config'}).then(function(result){return result.configuration;});},getState:function(key){return call({kind:'get',key:key});},setState:function(key,value){return call({kind:'set',key:key,value:value});},deleteState:function(key){return call({kind:'delete',key:key});},subscribe:subscribe,getContext:function(){return currentContext;},onContext:function(listener){if(typeof listener!=='function')throw new TypeError('UI context listener must be a function');contextListeners.add(listener);return function(){contextListeners.delete(listener);};},invoke:function(method,args){return call({kind:'invoke',method:method,args:args===undefined?null:args});},client:clientApi,agents:agents}),writable:false,configurable:false});
setTimeout(announce,0);
})();`;
}
