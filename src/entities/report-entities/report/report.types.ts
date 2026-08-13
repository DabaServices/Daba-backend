import { Transaction } from 'sequelize';
import { IReportItem } from '../report-item/report-item.model';
import { IReport } from './report.model';

export type SaveCommitteesBody = {
  changes: {
    materialId: string;
    type: number;
    unitId: number;
    quantity: number;
    status: string;
  }[];
  children: number[];
};

export type SaveAllocationsDTO = {
  changes: {
    materialId: string;
    unitId: number;
    quantity: number;
  }[];
  children: number[];
};

export type DownloadAllocationsDTO = {
  materialId?: string;
};

export type AllocationDuhExportRowDto = {
  materialId: string;
  materialDescription: string;
  quantity: number;
  unitOfMeasure: string;
  unitLevelId: number;
  unitSimul: string;
  unitDescription: string;
};

export type AllocationDuhGroupConversionDto = {
  groupId: string;
  groupDescription: string;
  materialId: string;
  materialDescription: string;
};

export type AllocationDuhExportDto = {
  fileName: string;
  rows: AllocationDuhExportRowDto[];
  groupConversions: AllocationDuhGroupConversionDto[];
};

export type AggregateReportsDTO = {
  unitsIds: number[];
  lowerUnitsIds: number[];
  isLaunching: boolean;
};

export type AggregateUnitDto = UnitDto & {
  isEmergencyUnit: boolean;
};

export type AggregateHierarchyMapsDto = {
  unitIds: number[];
  lowerUnitsIds: number[];
  unitsMap: Record<number, AggregateUnitDto>;
  childrenByParentMap: Record<number, AggregateUnitDto[]>;
};

export type IReportsChanges = {
  header: IReport;
  items: IReportItem[];
};

export type ReportItemConflictField = keyof Pick<
  IReportItem,
  | 'confirmedQuantity'
  | 'reportedQuantity'
  | 'balanceQuantity'
  | 'status'
  | 'changedAt'
  | 'changedBy'
  | 'modifiedAt'
>;

export type ReportChanges<
  Key extends ReportItemConflictField = ReportItemConflictField,
> = {
  transaction: Transaction;
  reportsToSave: IReportsChanges[];
  skipEmptyItems?: boolean;
  fieldsToUpdate?: Key[];
};

export type UnitStatusDto = {
  id: number;
  description: string;
};

export type UnitDto = {
  id: number;
  description: string;
  level: number;
  simul: string;
  parent?: UnitDto | null;
  status: UnitStatusDto;
};

export type ReportItemTypeDto = {
  id: number;
  quantity: number;
  availableQuantityToEat: number;
  yesterdayInventoryQuantity: number | null;
  comment: string;
  status: string | null;
};

export type ReportItemDto = {
  unit: UnitDto;
  allocatedQuantity: number | null;
  types: ReportItemTypeDto[];
};

export type MaterialDto = {
  id: string;
  description: string;
  multiply: number;
  nickname: string;
  category: string;
  unitOfMeasure: string;
  type: string;
};

export type ReportCommentDto = {
  comment: string;
  type: number;
};

export type ReportDto = {
  material: MaterialDto;
  comments: ReportCommentDto[];
  receivedAllocationQuantity: number | null;
  quantityLeftToAllocate: number | null;
  items: ReportItemDto[];
};

export type FavoriteReportDto = {
  material: MaterialDto;
  items: ReportItemDto[];
};

export type InventoryCalculationResultDto = {
  materialId: string;
  unitId: number;
  quantity: number;
};

export type InventoryCalculationBody = {
  materialsIds: string[];
};

export type AggregatedMaterials = {
  materialId: string;
  quantity: number;
  status: string;
  multiply?: number;
};
