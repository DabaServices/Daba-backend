import { BadGatewayException } from "@nestjs/common";
import Decimal from "decimal.js";
import { isDefined, isEmptyish, isNullish } from "remeda";
import { MESSAGE_TYPES, OBJECT_TYPES, RECORD_STATUS, REPORT_TYPES, UNIT_LEVELS, UNIT_RELATION_TYPES, UNIT_STATUSES } from "../../../../constants";
import { UnitRelation } from "../../../unit-entities/unit-relations/unit-relation.model";
import { formatDate } from "../../../../utils/date";
import { Report } from "../report.model";
import { AggregatedMaterials, AggregateUnitDto, IReportsChanges, UnitDto, UnitStatusDto } from "../report.types";
import { hasHierarchyChanged } from "./report-common.utils";

export const DEFAULT_STATUS: UnitStatusDto = {
    id: 0,
    description: "בדיווח",
};

export type CalcReportKey = `${string}::${string}::${number}`;

export type CalcReport = {
    [key: CalcReportKey]: {
        id: number;
        unitId: number;
        recipientUnitId: number;
        unitObjectType: string;
        recipientUnitObjectType: string;
        reportTypeId: number;
        reporterUnitId: number;
        reporterUnitObjectType: string;
        createdOn: string;
        createdBy: string;
        createdAt: string;
        items: {
            [materialId: string]: {
                materialId: string;
                reportingUnitId: number;
                reportingUnitObjectType: string;
                reportingLevel: number;
                confirmedQuantity: number;
                reportedQuantity: number;
                status: string;
                modifiedAt: string;
                changedAt: string;
                changedBy: string;
            };
        };
    };
};

export type HierarchyReportsIndex = {
    all: Report[];
    childrenByParentUnitId: Record<number, Record<number, Report[]>>;
    getUnitReports: (unitId: number) => Report[];
    getChildrenReports: (parentUnitId: number) => Record<number, Report[]>;
};

export type UnitSource = {
    activeDetail?: { dataValues?: { description?: string | null; unitLevelId?: number | null; tsavIrgunCodeId?: string | null } };
    details?: Array<{ dataValues?: { description?: string | null; unitLevelId?: number | null; tsavIrgunCodeId?: string | null } }>;
    unitStatus?: Array<{ unitStatus?: { dataValues?: { id: number; description: string }; id?: number; description?: string } }>;
};

export const sortNumeric = (values: number[]): number[] =>
    Array.from(new Set(values)).sort((a, b) => a - b);

export const collectHierarchyUnitIds = (
    screenUnitId: number,
    childrenByParent: Map<number, number[]>
): number[] => {
    const visited = new Set<number>([screenUnitId]);
    const queue = [screenUnitId];

    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) continue;

        for (const childId of childrenByParent.get(current) ?? []) {
            if (visited.has(childId)) continue;
            visited.add(childId);
            queue.push(childId);
        }
    }

    return sortNumeric(Array.from(visited));
};

export const toParentDto = (unit: AggregateUnitDto): UnitDto => ({
    id: unit.id,
    description: unit.description,
    level: unit.level,
    simul: unit.simul,
    status: unit.status,
    parent: null,
});

export const buildAggregateUnitFromSource = (
    unitId: number,
    unit: UnitSource | undefined,
    emergencyUnitLookup: Record<number, boolean>
): AggregateUnitDto => {
    const detail = unit?.activeDetail?.dataValues ?? unit?.details?.[0]?.dataValues;
    const statusModel = unit?.unitStatus?.[0]?.unitStatus;
    const status = statusModel?.dataValues
        ?? (statusModel?.id ? { id: statusModel.id, description: statusModel.description ?? "" } : DEFAULT_STATUS);

    return {
        id: unitId,
        description: detail?.description ?? "",
        level: detail?.unitLevelId ?? 0,
        simul: detail?.tsavIrgunCodeId ?? "",
        status,
        isEmergencyUnit: !!emergencyUnitLookup[unitId],
        parent: null,
    };
};

export const upsertAggregateUnit = (
    unitsById: Map<number, AggregateUnitDto>,
    candidate: AggregateUnitDto
) => {
    const existing = unitsById.get(candidate.id);
    if (!existing) {
        unitsById.set(candidate.id, candidate);
        return;
    }

    const merged: AggregateUnitDto = {
        ...existing,
        description: existing.description || candidate.description,
        level: existing.level || candidate.level,
        simul: existing.simul || candidate.simul,
        status: existing.status.id ? existing.status : candidate.status,
        isEmergencyUnit: existing.isEmergencyUnit || candidate.isEmergencyUnit,
        parent: existing.parent ?? null,
    };

    unitsById.set(candidate.id, merged);
};

export const buildHierarchyIndexes = (
    relations: UnitRelation[],
    emergencyUnitLookup: Record<number, boolean>
) => {
    const childrenByParent = new Map<number, number[]>();
    const parentsByChild = new Map<number, number[]>();
    const unitsById = new Map<number, AggregateUnitDto>();

    for (const relation of relations) {
        const parentId = relation.unitId;
        const childId = relation.relatedUnitId;

        const children = childrenByParent.get(parentId) ?? [];
        children.push(childId);
        childrenByParent.set(parentId, children);

        const parents = parentsByChild.get(childId) ?? [];
        parents.push(parentId);
        parentsByChild.set(childId, parents);

        upsertAggregateUnit(
            unitsById,
            buildAggregateUnitFromSource(parentId, relation.unit, emergencyUnitLookup)
        );
        upsertAggregateUnit(
            unitsById,
            buildAggregateUnitFromSource(childId, relation.relatedUnit, emergencyUnitLookup)
        );
    }

    return { childrenByParent, parentsByChild, unitsById };
};

export const assertLowerHierarchyStable = (
    screenLowerUnits: number[],
    dbLowerUnits: number[]
) => {
    if (isDefined(screenLowerUnits) && !hasHierarchyChanged([...screenLowerUnits], [...dbLowerUnits], []).changed) return;

    throw new BadGatewayException({
        message: 'ההיררכיה תחתיך השתנתה, יש לרענן את המסך',
        type: MESSAGE_TYPES.FAILURE
    });
};

export const buildUnitResolver = (
    unitsById: Map<number, AggregateUnitDto>,
    emergencyUnitLookup: Record<number, boolean>
) => {
    return (unitId: number, source?: UnitSource): AggregateUnitDto => {
        const existing = unitsById.get(unitId);
        if (existing) return existing;

        const candidate = buildAggregateUnitFromSource(unitId, source, emergencyUnitLookup);
        upsertAggregateUnit(unitsById, candidate);
        return unitsById.get(unitId) ?? candidate;
    };
};

export const buildUnitsMap = (
    connectedUnitIds: number[],
    screenUnitId: number,
    parentsByChild: Map<number, number[]>,
    resolveUnit: (unitId: number, source?: UnitSource) => AggregateUnitDto
): Record<number, AggregateUnitDto> => {
    const unitsMap: Record<number, AggregateUnitDto> = {};
    const unitIdsToBuild = new Set<number>(connectedUnitIds);

    for (const parentId of parentsByChild.get(screenUnitId) ?? []) {
        unitIdsToBuild.add(parentId);
    }

    for (const unitId of sortNumeric(Array.from(unitIdsToBuild))) {
        const unit = resolveUnit(unitId);
        const parentId = sortNumeric(parentsByChild.get(unitId) ?? [])[0] ?? null;
        if (parentId !== null) {
            unit.parent = toParentDto(resolveUnit(parentId));
        }

        unitsMap[unitId] = unit;
    }

    return unitsMap;
};

export const buildChildrenByParentMap = (
    childrenByParent: Map<number, number[]>,
    connectedUnitSet: Set<number>,
    unitsMap: Record<number, AggregateUnitDto>,
    resolveUnit: (unitId: number, source?: UnitSource) => AggregateUnitDto
): Record<number, AggregateUnitDto[]> => {
    const childrenByParentMap: Record<number, AggregateUnitDto[]> = {};

    for (const [parentId, children] of childrenByParent) {
        if (!connectedUnitSet.has(parentId)) continue;

        const filteredChildren = sortNumeric(
            children.filter((childId) => {
                if (!connectedUnitSet.has(childId)) return false;

                const childUnit = unitsMap[childId] ?? resolveUnit(childId);
                return childUnit.parent?.id === parentId;
            })
        );

        if (filteredChildren.length === 0) continue;
        childrenByParentMap[parentId] = filteredChildren.map((childId) => unitsMap[childId] ?? resolveUnit(childId));
    }

    return childrenByParentMap;
};

const pushNumberKeyed = <T>(record: Record<number, T[]>, key: number, value: T) => {
    if (!record[key]) {
        record[key] = [];
    }

    record[key].push(value);
};

export const buildHierarchyReportsIndex = ({
    dbReports,
    childrenByParentMap,
}: {
    dbReports: Report[];
    childrenByParentMap: Record<number, AggregateUnitDto[]>;
}): HierarchyReportsIndex => {
    const byUnitId: Record<number, Report[]> = {};
    const childrenByParentUnitId: Record<number, Record<number, Report[]>> = {};

    for (const [parentIdAsString, children] of Object.entries(childrenByParentMap)) {
        const parentId = Number(parentIdAsString);
        const childReports: Record<number, Report[]> = {};

        for (const child of children) {
            childReports[child.id] = [];
        }

        childrenByParentUnitId[parentId] = childReports;
    }

    for (const report of dbReports) {
        pushNumberKeyed(byUnitId, report.unitId, report);

        if (report.recipientUnitId === null) continue;

        const parentChildrenReports = childrenByParentUnitId[report.recipientUnitId];
        if (!parentChildrenReports) continue;
        if (!parentChildrenReports[report.unitId]) continue;

        parentChildrenReports[report.unitId].push(report);
    }

    return {
        all: dbReports,
        childrenByParentUnitId,
        getUnitReports: (unitId: number) => byUnitId[unitId] ?? [],
        getChildrenReports: (parentUnitId: number) => childrenByParentUnitId[parentUnitId] ?? {},
    };
};

const upsertReports = (
    reports: CalcReport,
    reportType: number,
    unitId: number,
    parentUnit: AggregateUnitDto,
    unitReport: Report | undefined,
    screenUnitId: number,
    date: string,
    aggregatedMaterials: AggregatedMaterials[],
    username: string
) => {
    if (!aggregatedMaterials.length) return;

    const reportKey = `${unitId}::${parentUnit.id}::${reportType}`;
    const { formattedTime, timestamp } = formatDate(new Date());

    if (!reports[reportKey]) {
        reports[reportKey] = {
            unitId,
            unitObjectType: OBJECT_TYPES.UNIT,
            recipientUnitId: parentUnit.id,
            reportTypeId: reportType,
            recipientUnitObjectType: OBJECT_TYPES.UNIT,
            reporterUnitId: unitReport?.dataValues?.reporterUnitId ?? screenUnitId,
            reporterUnitObjectType: unitReport?.dataValues?.reporterUnitObjectType ?? OBJECT_TYPES.UNIT,
            createdBy: unitReport?.dataValues?.createdBy ?? username,
            createdOn: unitReport?.dataValues?.createdOn ?? date,
            createdAt: unitReport?.dataValues?.createdAt ?? formattedTime,
            items: {},
        };
    }

    for (const material of aggregatedMaterials) {
        const existing = reports[reportKey]?.items[material.materialId];
        const quantity = getReportQuantity(reportType, material);

        if (existing) {
            existing.reportedQuantity = quantity;
            existing.confirmedQuantity = quantity;
            existing.status = material.status;
            existing.modifiedAt = timestamp;
            existing.changedAt = formattedTime;
            existing.changedBy = username;
        } else {
                reports[reportKey].items[material.materialId] = {
                materialId: material.materialId,
                reportingUnitId: parentUnit?.id,
                reportingUnitObjectType: OBJECT_TYPES.UNIT,
                reportingLevel: parentUnit?.level,
                reportedQuantity: quantity,
                confirmedQuantity: quantity,
                status: material.status,
                modifiedAt: timestamp,
                changedAt: formattedTime,
                changedBy: username,
            };
        }
    }

    for (const reportItem of unitReport?.items ?? []) {
        if (!aggregatedMaterials.some(mat => mat.materialId === reportItem.materialId)) {
            reports[reportKey].items[reportItem.materialId] = {
                materialId: reportItem.materialId,
                reportingUnitId: parentUnit?.id,
                reportingUnitObjectType: OBJECT_TYPES.UNIT,
                reportingLevel: parentUnit?.level,
                reportedQuantity: Number(reportItem.confirmedQuantity),
                confirmedQuantity: Number(reportItem.confirmedQuantity),
                status: RECORD_STATUS.INACTIVE,
                modifiedAt: timestamp,
                changedAt: formattedTime,
                changedBy: username,
            };
        }
    }
}

const toSafeQuantity = (value: string | number | null | undefined) => {
    const parsedQuantity = Number(value ?? 0);

    return Number.isNaN(parsedQuantity) ? 0 : parsedQuantity;
};

const toSafeMultiply = (value: string | number | null | undefined) => {
    const parsedMultiply = Number(value ?? 0);

    return Number.isFinite(parsedMultiply) && parsedMultiply > 1 ? parsedMultiply : 0;
};

const getReportItemMultiply = (
    item: { material?: { multiply?: string | number | null; dataValues?: { multiply?: string | number | null } } }
) => toSafeMultiply(item.material?.multiply ?? item.material?.dataValues?.multiply);

const roundToNearestMultiply = (quantity: number, multiply: number | undefined) => {
    const safeMultiply = toSafeMultiply(multiply);

    if (quantity <= 0 || safeMultiply <= 1) return quantity;

    const roundedQuantity = new Decimal(quantity)
        .div(safeMultiply)
        .toNearest(1)
        .times(safeMultiply)
        .toNumber();

    return Math.max(safeMultiply, roundedQuantity);
};

const getReportQuantity = (reportType: number, material: AggregatedMaterials) => {
    const quantity = toSafeQuantity(material.quantity);

    return reportType === REPORT_TYPES.REQUEST
        ? roundToNearestMultiply(quantity, material.multiply)
        : quantity;
};

const mergeAggregatedMaterial = (
    aggregatedMaterials: AggregatedMaterials[],
    candidate: AggregatedMaterials
) => {
    const existing = aggregatedMaterials.find(material => material.materialId === candidate.materialId);
    const quantity = toSafeQuantity(candidate.quantity);

    if (!existing) {
        aggregatedMaterials.push({
            materialId: candidate.materialId,
            quantity,
            status: candidate.status,
            multiply: candidate.multiply,
        });
        return;
    }

    if (isNullish(existing.multiply) && !isNullish(candidate.multiply)) {
        existing.multiply = candidate.multiply;
    }

    if (candidate.status === RECORD_STATUS.ACTIVE) {
        if (existing.status === RECORD_STATUS.ACTIVE) {
            existing.quantity += quantity;
        } else {
            existing.quantity = quantity;
            existing.status = RECORD_STATUS.ACTIVE;
        }

        return;
    }

    if (existing.status !== RECORD_STATUS.ACTIVE) {
        existing.quantity = quantity;
        existing.status = RECORD_STATUS.INACTIVE;
    }
};

const applyUnitReportStatusOverride = (
    aggregatedMaterials: AggregatedMaterials[],
    unitReport: Report | undefined
) => {
    for (const item of unitReport?.items ?? []) {
        const existing = aggregatedMaterials.find(material => material.materialId === item.materialId);
        const quantity = toSafeQuantity(item.confirmedQuantity ?? item.reportedQuantity);
        const status = item.status ?? RECORD_STATUS.ACTIVE;

        if (existing) {
            existing.status = status;
            if (existing.quantity === 0 && status === RECORD_STATUS.ACTIVE) {
                existing.quantity = quantity;
            }
            if (isNullish(existing.multiply)) {
                existing.multiply = getReportItemMultiply(item);
            }

            continue;
        }

        aggregatedMaterials.push({
            materialId: item.materialId,
            quantity,
            status,
            multiply: getReportItemMultiply(item),
        });
    }
};

const calculateReports = async (
    currentUnit: AggregateUnitDto,
    reportType: number,
    date: string,
    screenUnitId: number,
    unitsMap: Record<number, AggregateUnitDto>,
    childrenByParentMap: Record<number, AggregateUnitDto[]>,
    reports: CalcReport,
    hierarchyReportsIndex: HierarchyReportsIndex,
    username: string,
    isLaunching: boolean
) => {
    let aggregatedMaterials: AggregatedMaterials[] = [];

    try {
        const parentUnit = unitsMap[currentUnit.parent?.id ?? -1];
        const unitReports = hierarchyReportsIndex.getUnitReports(currentUnit.id);
        const unitReport = unitReports.find((report) => report.reportTypeId === reportType &&
            report.recipientUnitId === parentUnit?.id);

        const childrenReports = Object
            .values(hierarchyReportsIndex.getChildrenReports(currentUnit.id))
            .flat()
            .filter(report => report.reportTypeId === reportType);

        const childrenUnits = childrenByParentMap[currentUnit.id] ?? [];

        if (currentUnit.level !== UNIT_LEVELS.GDUD &&
            reportType !== REPORT_TYPES.REQUEST &&
            ((unitReport && childrenUnits.every(child => !child.isEmergencyUnit))
                || (isEmptyish(childrenReports) && isDefined(unitReport)))
        ) {
            aggregatedMaterials.push(...unitReport?.items?.map(item => ({
                materialId: item.materialId,
                quantity: 0,
                status: RECORD_STATUS.ACTIVE,
                multiply: getReportItemMultiply(item),
            })) ?? []);

            upsertReports(
                reports,
                reportType,
                currentUnit.id,
                parentUnit,
                unitReport,
                screenUnitId,
                date,
                aggregatedMaterials,
                username
            )
        }

        if (((currentUnit.status.id === UNIT_STATUSES.WAITING_FOR_ALLOCATION ||
            currentUnit.level === UNIT_LEVELS.GDUD) && unitReport)) {
            for (const item of unitReport.items ?? []) {
                mergeAggregatedMaterial(aggregatedMaterials, {
                    materialId: item.materialId,
                    quantity: toSafeQuantity(item.confirmedQuantity ?? item.reportedQuantity),
                    status: item.status ?? RECORD_STATUS.ACTIVE,
                    multiply: getReportItemMultiply(item),
                });
            }

            upsertReports(
                reports,
                reportType,
                currentUnit.id,
                parentUnit,
                unitReport,
                screenUnitId,
                date,
                aggregatedMaterials,
                username
            );

            return aggregatedMaterials;
        }

        for (const unitChild of childrenUnits) {
            const childAggregation = await calculateReports(
                unitChild,
                reportType,
                date,
                screenUnitId,
                unitsMap,
                childrenByParentMap,
                reports,
                hierarchyReportsIndex,
                username,
                isLaunching
            );

            if (childAggregation.length) {
                for (const item of childAggregation) {
                    mergeAggregatedMaterial(aggregatedMaterials, item);
                }
            }
        }

        applyUnitReportStatusOverride(aggregatedMaterials, unitReport);

        upsertReports(
            reports,
            reportType,
            currentUnit.id,
            parentUnit,
            unitReport,
            screenUnitId,
            date,
            aggregatedMaterials,
            username
        );

        return aggregatedMaterials;
    } catch (error) {
        console.log(error);

        throw new BadGatewayException({
            message: 'העלאת הדיווחים נכשלה, יש לנסות שוב',
            type: MESSAGE_TYPES.FAILURE
        });

    }
}

const formatReportsToDB = (reports: CalcReport) => {
    const reportsToDB: IReportsChanges[] = [];

    for (const key of Object.keys(reports)) {
        const header = reports[key];

        reportsToDB.push({
            header,
            items: Object.values(header.items)
        });
    }

    return reportsToDB;
}


export const getAggregatedReports = async ({
    date,
    unitsToLaunch,
    screenUnitId,
    unitsMap,
    childrenByParentMap,
    dbReports,
    username,
    isLaunching
}: {
    date: string,
    unitsToLaunch: number[],
    screenUnitId: number,
    unitsMap: Record<number, AggregateUnitDto>,
    childrenByParentMap: Record<number, AggregateUnitDto[]>,
    dbReports: Report[],
    username: string,
    isLaunching: boolean,
}) => {
    const reports: CalcReport = {};
    const hierarchyReportsIndex = buildHierarchyReportsIndex({
        dbReports,
        childrenByParentMap,
    });
    const requestedUnits = sortNumeric(Array.from(new Set(unitsToLaunch)));
    const requestedUnitsSet = new Set<number>(requestedUnits);
    const rootLaunchUnits = requestedUnits.filter((unitId) => {
        let parentId = unitsMap[unitId]?.parent?.id ?? null;

        while (parentId !== null) {
            if (requestedUnitsSet.has(parentId)) return false;
            parentId = unitsMap[parentId]?.parent?.id ?? null;
        }

        return true;
    });

    try {
        for (const unit of rootLaunchUnits) {
            const currentUnit = unitsMap[unit];
            if (!currentUnit) continue;

            for (const reportType of [REPORT_TYPES.USAGE, REPORT_TYPES.INVENTORY, REPORT_TYPES.REQUEST]) {
                await calculateReports(
                    currentUnit,
                    reportType,
                    date,
                    screenUnitId,
                    unitsMap,
                    childrenByParentMap,
                    reports,
                    hierarchyReportsIndex,
                    username,
                    isLaunching
                );
            }
        }
        return formatReportsToDB(reports);
    } catch (error) {
        throw error;
    }
}
