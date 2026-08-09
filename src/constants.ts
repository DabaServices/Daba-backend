export const ENVIRONMENTS = {
  NONPROD: 'nonprod',
  LOCALHOST: 'localhost',
};

export const RECORD_STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
};

export const MATERIAL_TYPES = {
  ITEM: 'ITEM',
  TOOL: 'TOOL',
};

export const UNIT_RELATION_TYPES = {
  ZRA: '1',
  COMPANY: '2',
};

export const OBJECT_TYPES = {
  UNIT: 'O',
  COMPANY: 'PL',
};

export const REPORTABLE_OBJECT_TYPES = [
  OBJECT_TYPES.UNIT,
  OBJECT_TYPES.COMPANY,
];

export const REPORTABLE_UNIT_RELATION_TYPES = [
  UNIT_RELATION_TYPES.ZRA,
];

export const MESSAGE_TYPES = {
  FATAL: 'Fatal',
  FAILURE: 'Failure',
  SUCCESS: 'Success',
  WARNING: 'Warning',
};

export const REPORT_TYPES = {
  REQUEST: 0,
  INVENTORY: 1,
  USAGE: 2,
  ALLOCATION: 4,
};

export const UNIT_LEVELS = {
  COMPANY: 5,
  GDUD: 4,
  HATIVA: 3,
  UGDA: 2,
  PIKUD: 1,
  MATKAL: 0,
};

export const UNIT_TYPES = {
  MATKAL: 1,
  MARLOG: 2,
  MALAN: 3,
  PIKUD: 4,
  EMERGENCY: 5,
};

export const REPORTABLE_UNIT_TYPES = [
  UNIT_TYPES.MATKAL,
  UNIT_TYPES.MARLOG,
  UNIT_TYPES.MALAN,
  UNIT_TYPES.PIKUD,
  UNIT_TYPES.EMERGENCY,
];

export const UNIT_STATUSES = {
  REQUESTING: 0,
  WAITING_FOR_ALLOCATION: 1,
  ALLOCATING: 2,
  FINISHED: 3,
};

export const SUPPLY_CENTERS = {
  AMMO: 21,
  TIKSHUV: 48
};

export const enum UnitObjectTypes {
  Frame = 'O',
}

export const MATKAL_UNIT_ID = Number(process.env.MATKAL_UNIT_ID);
export const MARTACH_UNIT_ID = Number(process.env.MARTACH_UNIT_ID);
