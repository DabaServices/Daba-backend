export type UnitStatus = {
  id: number;
  description: string;
};

export type UnitHierarchyNode = {
  id: number;
  description: string;
  level: number;
  simul: string;
  isConnectedToRoot?: boolean;
  isConnectedToMatkal?: boolean;
  isRootUnit?: boolean;
  isEmergencyUnit: boolean;
  parent?: UnitHierarchyParent | null;
  status: UnitStatus;
};

export type UnitHierarchyParent = {
  id: number;
  description: string;
  level: number;
  simul: string;
  status: UnitStatus;
};
