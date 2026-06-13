import { OBJECT_TYPES, RECORD_STATUS, REPORT_TYPES, UNIT_STATUSES } from "../../../../constants";
import { Report } from "../report.model";
import { IUnit } from "../../../unit-entities/unit/unit.model";
import { combineDateAndTime } from "../../../../utils/date";
import { IReportsChanges, SaveAllocationsDTO } from "../report.types";

type AllocationChange = SaveAllocationsDTO["changes"][number] & {
    existingConfirmedQuantity?: number;
    existingBalanceQuantity?: number;
};

type BaseAllocationParams = {
    username: string;
    creationTime: string;
    screenDate: Date;
};

type BuildConfirmedAllocationsParams = BaseAllocationParams & {
    changes: AllocationChange[];
    screenUnit: Pick<IUnit, "unitId" | "unitLevelId">;
};

type BuildDraftAllocationsParams = BaseAllocationParams & {
    childIdsByParent: Map<number, number[]>;
    changes: AllocationChange[];
    unitLevelById: Map<number, number>;
    requisitionReports: Report[];
};

type BuildBalanceUpdatesParams = {
    username: string;
    creationTime: string;
    allocationChanges: AllocationChange[];
    incomingAllocationReports: Report[];
};

const toNumber = (value: string | number | null | undefined) => {
    const parsed = Number(value ?? 0);
    return Number.isNaN(parsed) ? 0 : parsed;
};

const buildBaseItem = (username: string, creationTime: string, modifiedAt: Date) => ({
    status: RECORD_STATUS.ACTIVE,
    changedBy: username,
    changedAt: creationTime,
    modifiedAt,
});

const isInactiveItem = (status: string | null | undefined) => status === RECORD_STATUS.INACTIVE;

const buildHeader = (
    unitId: number,
    recipientUnitId: number,
    username: string,
    creationTime: string,
    screenDate: Date
) => ({
    reportTypeId: REPORT_TYPES.ALLOCATION,
    unitId,
    unitObjectType: OBJECT_TYPES.UNIT,
    recipientUnitId,
    recipientUnitObjectType: OBJECT_TYPES.UNIT,
    reporterUnitId: unitId,
    reporterUnitObjectType: OBJECT_TYPES.UNIT,
    createdOn: screenDate,
    createdBy: username,
    createdAt: creationTime
});

export const mergeMatkalRequisitionAllocations = (
    changes: AllocationChange[],
    requisitionReports: Report[]
): AllocationChange[] => {
    const merged = new Map<string, AllocationChange>();

    for (const change of changes) {
        merged.set(`${change.unitId}:${change.materialId}`, change);
    }

    for (const report of requisitionReports) {
        for (const item of report.items ?? []) {
            if (isInactiveItem(item.status)) continue;
            if (!item.materialId) continue;

            const key = `${report.unitId}:${item.materialId}`;
            if (merged.has(key)) continue;

            merged.set(key, {
                unitId: report.unitId,
                materialId: item.materialId,
                quantity: toNumber(item.confirmedQuantity ?? item.reportedQuantity),
            });
        }
    }

    return Array.from(merged.values());
};

export const buildAllocationChangesFromRequisitionReports = (requisitionReports: Report[]): AllocationChange[] => {
    const changesByKey = new Map<string, AllocationChange>();

    for (const report of requisitionReports) {
        for (const item of report.items ?? []) {
            if (isInactiveItem(item.status)) continue;
            if (!item.materialId) continue;

            const quantity = toNumber(item.confirmedQuantity ?? item.reportedQuantity);

            if (quantity !== 0) {
                const key = `${report.unitId}:${item.materialId}`;
                changesByKey.set(key, {
                    unitId: report.unitId,
                    materialId: item.materialId,
                    quantity,
                });
            }
        }
    }

    return Array.from(changesByKey.values());
};

export const buildAllocationChangesFromReports = (reports: Report[], isDvhExcel: boolean): AllocationChange[] => {
    const changesByKey = new Map<string, AllocationChange>();

    for (const report of reports) {
        for (const item of report.items ?? []) {
            if (!item.materialId || report.recipientUnitId === null) continue;

            const quantity = isDvhExcel
                ? toNumber(item.confirmedQuantity)
                : toNumber(item.reportedQuantity);

            if (isDvhExcel || quantity !== 0) {
                const key = `${report.recipientUnitId}:${item.materialId}`;
                changesByKey.set(key, {
                    unitId: report.recipientUnitId,
                    materialId: item.materialId,
                    quantity,
                    existingConfirmedQuantity: toNumber(item.confirmedQuantity),
                    existingBalanceQuantity: toNumber(item.balanceQuantity),
                });
            }
        }
    }

    return Array.from(changesByKey.values());
};

export const buildDownloadAllocationChanges = ({
    isMatkal,
    matkalStatusId,
    outgoingAllocationReports,
    requisitionReports,
    isDvhExcel
}: {
    isMatkal: boolean;
    matkalStatusId?: number | null;
    outgoingAllocationReports: Report[];
    requisitionReports: Report[];
    isDvhExcel: boolean;
}): AllocationChange[] => {
    if (!isMatkal) {
        return buildAllocationChangesFromReports(outgoingAllocationReports, isDvhExcel);
    }

    const statusId = matkalStatusId ?? UNIT_STATUSES.REQUESTING;
    if (statusId === UNIT_STATUSES.REQUESTING && outgoingAllocationReports.length === 0) {
        return buildAllocationChangesFromRequisitionReports(requisitionReports);
    }

    return buildAllocationChangesFromReports(outgoingAllocationReports, isDvhExcel);
};

export const buildAllocationsChanges = ({
    changes,
    username,
    creationTime,
    screenUnit,
    screenDate
}: BuildConfirmedAllocationsParams): IReportsChanges[] => {
    const reportsByKey = new Map<string, IReportsChanges>();
    const modifiedAt = combineDateAndTime(new Date(), creationTime);

    for (const change of changes) {
        const key = `${change.unitId}`;

        if (!reportsByKey.has(key)) {
            reportsByKey.set(key, {
                header: buildHeader(
                    screenUnit.unitId,
                    change.unitId,
                    username,
                    creationTime,
                    screenDate
                ),
                items: []
            });
        }

        reportsByKey.get(key)?.items.push({
            materialId: change.materialId,
            reportedQuantity: change.quantity,
            reportingLevel: screenUnit.unitLevelId,
            reportingUnitId: screenUnit.unitId,
            reportingUnitObjectType: OBJECT_TYPES.UNIT,
            ...buildBaseItem(username, creationTime, modifiedAt),
        } as IReportsChanges["items"][0]);
    }

    return Array.from(reportsByKey.values());
};

export const buildConfirmedAllocationChanges = ({
    changes,
    username,
    creationTime,
    screenUnit,
    screenDate
}: BuildConfirmedAllocationsParams): IReportsChanges[] => {
    const reportsByKey = new Map<string, IReportsChanges>();
    const modifiedAt = combineDateAndTime(new Date(), creationTime);

    for (const change of changes) {
        const key = `${change.unitId}`;
        const existing = reportsByKey.get(key);

        if (!existing) {
            reportsByKey.set(key, {
                header: buildHeader(
                    screenUnit.unitId,
                    change.unitId,
                    username,
                    creationTime,
                    screenDate
                ),
                items: []
            });
        }

        reportsByKey.get(key)?.items.push({
            materialId: change.materialId,
            reportedQuantity: 0,
            confirmedQuantity: (change.existingConfirmedQuantity ?? 0) + change.quantity,
            balanceQuantity: (change.existingBalanceQuantity ?? 0) + change.quantity,
            reportingLevel: screenUnit.unitLevelId,
            reportingUnitId: screenUnit.unitId,
            reportingUnitObjectType: OBJECT_TYPES.UNIT,
            ...buildBaseItem(username, creationTime, modifiedAt),
        } as IReportsChanges["items"][0]);
    }

    return Array.from(reportsByKey.values());
};

export const buildNextLevelAllocationDraftChanges = ({
    childIdsByParent,
    changes,
    username,
    creationTime,
    screenDate,
    unitLevelById,
    requisitionReports,
}: BuildDraftAllocationsParams): IReportsChanges[] => {
    const reportsByKey = new Map<string, IReportsChanges>();
    const handledChildMaterial = new Set<string>();
    const modifiedAt = combineDateAndTime(new Date(), creationTime);
    const requisitionByRecipientChildMaterial = new Map<string, number>();

    for (const report of requisitionReports) {
        for (const item of report.items ?? []) {
            if (isInactiveItem(item.status)) continue;
            if (!item.materialId) continue;
            const key = `${report.recipientUnitId}:${report.unitId}:${item.materialId}`;
            requisitionByRecipientChildMaterial.set(
                key,
                (requisitionByRecipientChildMaterial.get(key) ?? 0) + toNumber(item.confirmedQuantity ?? item.reportedQuantity)
            );
        }
    }

    for (const change of changes) {
        const childMaterialKey = `${change.unitId}:${change.materialId}`;
        if (handledChildMaterial.has(childMaterialKey)) continue;
        handledChildMaterial.add(childMaterialKey);

        const childIds = childIdsByParent.get(change.unitId) ?? [];
        const childLevel = unitLevelById.get(change.unitId);
        if (childIds.length === 0 || childLevel === undefined) continue;

        for (const recipientUnitId of childIds) {
            const reportKey = `${change.unitId}:${recipientUnitId}`;
            if (!reportsByKey.has(reportKey)) {
                reportsByKey.set(reportKey, {
                    header: buildHeader(
                        change.unitId,
                        recipientUnitId,
                        username,
                        creationTime,
                        screenDate
                    ),
                    items: []
                });
            }

            reportsByKey.get(reportKey)?.items.push({
                materialId: change.materialId,
                reportedQuantity: requisitionByRecipientChildMaterial.get(`${change.unitId}:${recipientUnitId}:${change.materialId}`) ?? 0,
                reportingLevel: childLevel,
                reportingUnitId: change.unitId,
                reportingUnitObjectType: OBJECT_TYPES.UNIT,
                ...buildBaseItem(username, creationTime, modifiedAt),
            } as IReportsChanges["items"][0]);
        }
    }

    return Array.from(reportsByKey.values());
};

export const buildAllocationBalanceUpdates = ({
    allocationChanges,
    incomingAllocationReports,
    username,
    creationTime,
}: BuildBalanceUpdatesParams): IReportsChanges[] => {
    const allocatedByMaterial = new Map<string, number>();
    const reportsToSave: IReportsChanges[] = [];
    const modifiedAt = combineDateAndTime(new Date(), creationTime);

    for (const change of allocationChanges) {
        allocatedByMaterial.set(
            change.materialId,
            (allocatedByMaterial.get(change.materialId) ?? 0) + toNumber(change.quantity)
        );
    }

    for (const report of incomingAllocationReports) {
        const itemsToUpdate: IReportsChanges["items"] = [];

        for (const item of report.items ?? []) {
            if (!item.materialId) continue;

            const remainingAllocation = allocatedByMaterial.get(item.materialId) ?? 0;
            if (remainingAllocation <= 0) continue;

            const currentBalance = toNumber(item.balanceQuantity ?? item.confirmedQuantity ?? item.reportedQuantity);
            const deduction = Math.min(currentBalance, remainingAllocation);

            allocatedByMaterial.set(item.materialId, remainingAllocation - deduction);

            itemsToUpdate.push({
                materialId: item.materialId,
                reportedQuantity: toNumber(item.reportedQuantity),
                confirmedQuantity: toNumber(item.confirmedQuantity),
                balanceQuantity: currentBalance - deduction,
                reportingLevel: item.reportingLevel,
                reportingUnitId: item.reportingUnitId,
                reportingUnitObjectType: item.reportingUnitObjectType ?? OBJECT_TYPES.UNIT,
                status: item.status ?? RECORD_STATUS.ACTIVE,
                changedBy: username,
                changedAt: creationTime,
                modifiedAt,
            } as IReportsChanges["items"][0]);
        }

        if (itemsToUpdate.length === 0) continue;

        reportsToSave.push({
            header: {
                reportTypeId: report.reportTypeId,
                unitId: report.unitId,
                unitObjectType: report.unitObjectType ?? OBJECT_TYPES.UNIT,
                recipientUnitId: report.recipientUnitId,
                recipientUnitObjectType: report.recipientUnitObjectType ?? OBJECT_TYPES.UNIT,
                reporterUnitId: report.reporterUnitId,
                reporterUnitObjectType: report.reporterUnitObjectType ?? OBJECT_TYPES.UNIT,
                createdOn: report.createdOn,
                createdBy: report.createdBy,
                createdAt: report.createdAt,
            },
            items: itemsToUpdate,
        });
    }

    return reportsToSave;
};
