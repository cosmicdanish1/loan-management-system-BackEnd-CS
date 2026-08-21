// Re-exports the canonical DemandMaster entity. This file used to declare its
// own competing definition (composite mbno+month+year primary key) for the
// same demand_master table that transaction/entities/demand-master.entity.ts
// maps with a different assumed primary key (dmnd_srno) — two entity classes
// for one physical table, silently able to drift out of sync. Consolidated to
// a single source of truth.
export { DemandMaster } from '../../transaction/entities/demand-master.entity';
