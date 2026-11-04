import type {EntityManager} from 'typeorm';
const batches=new WeakSet<EntityManager>();
export const beginBaseCodeForm=(em:EntityManager)=>{batches.add(em);};
export const endBaseCodeForm=(em:EntityManager)=>{batches.delete(em);};
export const inBaseCodeForm=(em:EntityManager)=>batches.has(em);
