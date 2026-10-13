import { AsyncLocalStorage } from 'node:async_hooks';
const native=new AsyncLocalStorage();
export const withNewMateContext=(context,run)=>native.run(context,run);
export const newMateContext=()=>native.getStore();
