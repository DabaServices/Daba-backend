import type { Material } from "../../../material-entities/material/material.model";
import type { StandardGroup } from "../../../standard-entities/standard-group/standard-group.model";
import type { Report } from "../report.model";
import type { Unit } from "../../../unit-entities/unit/unit.model";
import type { UnitId } from "../../../unit-entities/unit-id/unit-id.model";
import type {
    FavoriteReportDto,
    MaterialDto,
    ReportCommentDto,
    ReportDto,
    ReportItemDto,
    ReportItemTypeDto,
    UnitDto,
    UnitStatusDto,
} from "../report.types";
import { MATERIAL_TYPES, RECORD_STATUS, REPORT_TYPES } from "../../../../constants";
import { UnitRelation } from "../../../unit-entities/unit-relations/unit-relation.model";
import { isDefined, isNullish } from "remeda";
import { log } from "util";

type FetchReportsParams = {
    screenUnitId: number;
    reports: Report[] | null | undefined;
    standaloneComments?: StandaloneComment[] | null | undefined;
    yesterdayInventoryReports?: Report[] | null | undefined;
    screenAllocationReports?: Report[] | null | undefined;
    fetchQuantity?: boolean;
};

type ReportItemAggregate = {
    materialId: string;
    unitId: number;
    unit: UnitDto;
    allocatedQuantity: number | null;
    type: ReportItemTypeDto;
};

type MaterialComment = NonNullable<Material["comments"]>[number];
type StandaloneComment = MaterialComment & {
    material?: Material;
    standardGroup?: StandardGroup;
    unit?: UnitId;
    recipientUnit?: UnitId;
};

const DEFAULT_STATUS: UnitStatusDto = {
    id: 0,
    description: "בדיווח",
};

const toNumber = (value: string | number | null | undefined) => {
    const parsed = Number(value ?? 0);
    return Number.isNaN(parsed) ? 0 : parsed;
};

const buildUnitDto = (
    unitId: number,
    detail: Unit | undefined,
    parent: UnitDto | null,
    status: { id: number; description: string } | undefined
): UnitDto => ({
    id: unitId,
    description: detail?.description ?? "",
    level: detail?.unitLevelId ?? 0,
    simul: detail?.tsavIrgunCodeId ?? "",
    parent,
    status: status?.id
        ? { id: status.id, description: status.description }
        : DEFAULT_STATUS,
});

const toParentUnitDto = (parent: UnitDto | null): UnitDto | null =>
    parent
        ? {
            ...parent,
            parent: null,
        }
        : null;

const getStandardGroupCategory = (standardGroup?: StandardGroup) =>
    standardGroup?.categoryGroup?.categoryDesc?.description
    ?? standardGroup?.groupType ?? 'כללי';

const getToolCategory = (material?: Material) =>
    material?.standardGroupMaterials
        ?.find((standardGroupMaterial) => standardGroupMaterial.standardGroup?.categoryGroup?.categoryDesc?.description)
        ?.standardGroup?.categoryGroup?.categoryDesc?.description;

const getMaterialCategory = (material?: Material, standardGroup?: StandardGroup) => {
    if (material?.type === MATERIAL_TYPES.TOOL) {
        return getToolCategory(material)
            ?? material.materialCategory?.mainCategory?.description
            ?? getStandardGroupCategory(standardGroup);
    }

    return material?.materialCategory?.mainCategory?.description
        ?? getStandardGroupCategory(standardGroup);
};

const buildMaterialDto = (
    materialId: string,
    material?: Material,
    standardGroup?: StandardGroup
): MaterialDto => ({
    id: materialId,
    description: material?.description ?? standardGroup?.name ?? "",
    multiply: toNumber(material?.multiply),
    nickname: material?.nickname?.nickname ?? standardGroup?.nickname?.nickname ?? "",
    category: getMaterialCategory(material, standardGroup),
    unitOfMeasure: material?.unitOfMeasurement ?? "יח",
    type: !isNullish(material)
        ? material.type ?? MATERIAL_TYPES.ITEM
        : isDefined(standardGroup)
            ? standardGroup?.groupType ?? 'כללי'
            : MATERIAL_TYPES.ITEM,
});

const getCommentUnitId = (comment: MaterialComment) =>
    comment.dataValues?.unitId ?? comment.unitId;

const getCommentRecipientUnitId = (comment: MaterialComment) =>
    comment.dataValues?.recipientUnitId ?? comment.recipientUnitId;

const getCommentMaterialId = (comment: MaterialComment) =>
    comment.dataValues?.materialId ?? comment.materialId;

const getCommentType = (comment: MaterialComment) =>
    comment.dataValues?.type ?? comment.type;

const getCommentText = (comment: MaterialComment) =>
    comment.dataValues?.text ?? comment.text ?? "";

const resolveCommentByAuthor = (
    comments: Material["comments"] | undefined,
    authorUnitId: number,
    scopedRecipientUnitId: number | null | undefined
): string => {
    const comment = comments?.find((comment) =>
        getCommentUnitId(comment) === authorUnitId &&
        getCommentRecipientUnitId(comment) === scopedRecipientUnitId &&
        Boolean(getCommentText(comment))
    );

    return comment ? getCommentText(comment) : "";
};

const addReportComment = (
    reportCommentsByMaterial: Map<string, Map<number, string>>,
    materialId: string,
    reportTypeId: number,
    commentText: string
) => {
    let commentsByType = reportCommentsByMaterial.get(materialId);
    if (!commentsByType) {
        commentsByType = new Map<number, string>();
        reportCommentsByMaterial.set(materialId, commentsByType);
    }

    if (!commentsByType.has(reportTypeId)) {
        commentsByType.set(reportTypeId, commentText);
    }
};

const buildYesterdayInventoryQuantityByUnitMaterial = (
    yesterdayInventoryReports: Report[] | null | undefined
) => {
    const yesterdayInventoryQuantityByUnitMaterial = new Map<string, number>();

    for (const report of yesterdayInventoryReports ?? []) {
        for (const item of report.items ?? []) {
            if (!item.materialId) continue;

            const quantity = toNumber(item.confirmedQuantity ?? item.reportedQuantity);
            const key = `${report.unitId}:${item.materialId}`;
            yesterdayInventoryQuantityByUnitMaterial.set(
                key,
                (yesterdayInventoryQuantityByUnitMaterial.get(key) ?? 0) + quantity
            );
        }
    }

    return yesterdayInventoryQuantityByUnitMaterial;
};

export const buildReportsResponse = ({
    screenUnitId,
    reports,
    standaloneComments,
    yesterdayInventoryReports,
    screenAllocationReports,
    fetchQuantity = true
}: FetchReportsParams): ReportDto[] => {
    if (!reports?.length && !standaloneComments?.length && !yesterdayInventoryReports?.length && !screenAllocationReports?.length) return [];

    const materialById = new Map<string, MaterialDto>();
    const itemByKey = new Map<string, ReportItemAggregate>();
    const reportCommentsByMaterial = new Map<string, Map<number, string>>();
    const yesterdayInventoryQuantityByUnitMaterial = buildYesterdayInventoryQuantityByUnitMaterial(yesterdayInventoryReports);
    const allocatedQuantityByMaterial = new Map<string, number>();
    const quantityLeftToAllocateByMaterial = new Map<string, number>();

    for (const report of screenAllocationReports ?? []) {
        for (const item of report.items ?? []) {
            if (!item.materialId) continue;

            if (!materialById.has(item.materialId)) {
                materialById.set(item.materialId, buildMaterialDto(item.materialId, item.material, item.standardGroup));
            }

            allocatedQuantityByMaterial.set(
                item.materialId,
                (allocatedQuantityByMaterial.get(item.materialId) ?? 0)
                + toNumber(item.confirmedQuantity)
            );

            quantityLeftToAllocateByMaterial.set(
                item.materialId,
                (quantityLeftToAllocateByMaterial.get(item.materialId) ?? 0)
                + toNumber(item.balanceQuantity)
            );
        }
    }

    for (const report of reports ?? []) {
        const isAllocationReport = report.reportTypeId === REPORT_TYPES.ALLOCATION;
        const isScreenUnitReport = !isAllocationReport && report.unitId === screenUnitId;
        const unitDetail = report.unit?.details?.[0];
        const recipientDetail = report.recipientUnit?.details?.[0];
        const unitStatus = report.unit?.unitStatus?.[0]?.unitStatus;
        const recipientStatus = report.recipientUnit?.unitStatus?.[0]?.unitStatus;

        const recipientUnit = buildUnitDto(
            report.recipientUnitId ?? screenUnitId,
            recipientDetail,
            null,
            recipientStatus
        );

        const reportingUnit = buildUnitDto(
            report.unitId,
            unitDetail,
            toParentUnitDto(recipientUnit),
            unitStatus
        );

        const allocationRecipientUnit = buildUnitDto(
            report.recipientUnitId ?? screenUnitId,
            recipientDetail,
            toParentUnitDto(reportingUnit),
            recipientStatus
        );

        const reportItems = report.items ?? [];
        for (const item of reportItems) {
            if (!item.materialId) continue;

            if (!materialById.has(item.materialId)) {
                materialById.set(item.materialId, buildMaterialDto(item.materialId, item.material, item.standardGroup));
            }

            const screenUnitCommentText = !isAllocationReport
                ? resolveCommentByAuthor(
                    item.material?.comments,
                    screenUnitId,
                    report.recipientUnitId
                )
                : '';

            if (!isAllocationReport && screenUnitCommentText) {
                addReportComment(reportCommentsByMaterial, item.materialId, report.reportTypeId, screenUnitCommentText);
            }

            const incomingAllocationComment = isAllocationReport && report.recipientUnitId === screenUnitId
                ? resolveCommentByAuthor(
                    item.material?.comments,
                    report.unitId,
                    report.recipientUnitId
                )
                : "";

            if (incomingAllocationComment) {
                addReportComment(reportCommentsByMaterial, item.materialId, REPORT_TYPES.ALLOCATION, incomingAllocationComment);
            }

            const childUnitComment = report.recipientUnitId === screenUnitId
                ? isAllocationReport
                    ? ""
                    : resolveCommentByAuthor(
                        item.material?.comments,
                        report.unitId,
                        report.recipientUnitId
                    ) : isAllocationReport
                    ? resolveCommentByAuthor(
                        item.material?.comments,
                        report.unitId,
                        report.recipientUnitId ?? screenUnitId
                    )
                    : "";

            const key = `${isAllocationReport ? report.recipientUnitId ?? screenUnitId : report.unitId}:${item.materialId}:${report.reportTypeId}:${report.recipientUnitId ?? 0}`;

            if (isAllocationReport || (!isScreenUnitReport && (toNumber(item.confirmedQuantity) !== 0 || report.reportTypeId !== REPORT_TYPES.REQUEST))) {
                itemByKey.set(key, {
                    materialId: item.materialId,
                    unitId: isAllocationReport ? report.recipientUnitId ?? screenUnitId : report.unitId,
                    unit: isAllocationReport ? allocationRecipientUnit : reportingUnit,
                    allocatedQuantity: isAllocationReport ? toNumber(item.confirmedQuantity) : null,
                    type: {
                        id: report.reportTypeId,
                        quantity: isAllocationReport
                            ? toNumber(item.reportedQuantity)
                            : fetchQuantity ? toNumber(item.confirmedQuantity) : 0,
                        availableQuantityToEat: isAllocationReport
                            ? toNumber(item.balanceQuantity)
                            : 0,
                        yesterdayInventoryQuantity: report.reportTypeId === REPORT_TYPES.INVENTORY
                            ? (yesterdayInventoryQuantityByUnitMaterial.get(`${report.unitId}:${item.materialId}`) ?? 0)
                            : null,
                        comment: childUnitComment,
                        status: item.status ?? null,
                    },
                });
            }
        }
    }

    for (const report of yesterdayInventoryReports ?? []) {
        if (report.unitId === screenUnitId) continue;

        const unitDetail = report.unit?.details?.[0];
        const recipientDetail = report.recipientUnit?.details?.[0];
        const unitStatus = report.unit?.unitStatus?.[0]?.unitStatus;
        const recipientStatus = report.recipientUnit?.unitStatus?.[0]?.unitStatus;

        const recipientUnit = buildUnitDto(
            report.recipientUnitId ?? screenUnitId,
            recipientDetail,
            null,
            recipientStatus
        );

        const reportingUnit = buildUnitDto(
            report.unitId,
            unitDetail,
            toParentUnitDto(recipientUnit),
            unitStatus
        );

        for (const item of report.items ?? []) {
            if (!item.materialId) continue;

            if (!materialById.has(item.materialId)) {
                materialById.set(item.materialId, buildMaterialDto(item.materialId, item.material, item.standardGroup));
            }

            const key = `${report.unitId}:${item.materialId}:${REPORT_TYPES.INVENTORY}:${report.recipientUnitId ?? 0}`;
            if (itemByKey.has(key)) continue;

            itemByKey.set(key, {
                materialId: item.materialId,
                unitId: report.unitId,
                unit: reportingUnit,
                allocatedQuantity: null,
                type: {
                    id: REPORT_TYPES.INVENTORY,
                    quantity: 0,
                    availableQuantityToEat: 0,
                    yesterdayInventoryQuantity: toNumber(item.confirmedQuantity ?? item.reportedQuantity),
                    comment: "",
                    status: item.status ?? null,
                },
            });
        }
    }

    for (const comment of standaloneComments ?? []) {
        const materialId = getCommentMaterialId(comment);
        const reportTypeId = getCommentType(comment);
        const commentText = getCommentText(comment);
        const commentUnitId = getCommentUnitId(comment);
        const commentRecipientUnitId = getCommentRecipientUnitId(comment);

        if (!materialId || isNullish(reportTypeId) || !commentText || !commentUnitId) {
            continue;
        }

        if (!materialById.has(materialId)) {
            materialById.set(materialId, buildMaterialDto(materialId, comment.material, comment.standardGroup));
        }

        if (reportTypeId === REPORT_TYPES.ALLOCATION && commentRecipientUnitId === screenUnitId) {
            addReportComment(reportCommentsByMaterial, materialId, reportTypeId, commentText);
            continue;
        }

        if (reportTypeId !== REPORT_TYPES.ALLOCATION && commentUnitId === screenUnitId) {
            addReportComment(reportCommentsByMaterial, materialId, reportTypeId, commentText);
            continue;
        }

        const isAllocationComment = reportTypeId === REPORT_TYPES.ALLOCATION;
        const itemUnitId = isAllocationComment
            ? commentRecipientUnitId
            : commentUnitId;

        if (!itemUnitId) {
            continue;
        }

        const itemUnitAssociation = isAllocationComment ? comment.recipientUnit : comment.unit;
        const parentUnitAssociation = isAllocationComment ? comment.unit : comment.recipientUnit;
        const parentUnitId = isAllocationComment ? commentUnitId : commentRecipientUnitId ?? screenUnitId;
        const parentUnit = buildUnitDto(
            parentUnitId,
            parentUnitAssociation?.details?.[0],
            null,
            parentUnitAssociation?.unitStatus?.[0]?.unitStatus
        );
        const itemUnit = buildUnitDto(
            itemUnitId,
            itemUnitAssociation?.details?.[0],
            toParentUnitDto(parentUnit),
            itemUnitAssociation?.unitStatus?.[0]?.unitStatus
        );
        const key = `${itemUnitId}:${materialId}:${reportTypeId}:${commentRecipientUnitId ?? 0}`;
        const existingItem = itemByKey.get(key);

        if (existingItem) {
            existingItem.type.comment = commentText;
            continue;
        }

        itemByKey.set(key, {
            materialId,
            unitId: itemUnitId,
            unit: itemUnit,
            allocatedQuantity: isAllocationComment ? 0 : null,
            type: {
                id: reportTypeId,
                quantity: 0,
                availableQuantityToEat: 0,
                yesterdayInventoryQuantity: reportTypeId === REPORT_TYPES.INVENTORY
                    ? (yesterdayInventoryQuantityByUnitMaterial.get(`${itemUnitId}:${materialId}`) ?? 0)
                    : null,
                comment: commentText,
                status: RECORD_STATUS.ACTIVE,
            },
        });
    }

    const grouped = new Map<string, Map<number, ReportItemDto>>();
    for (const aggregate of itemByKey.values()) {
        let byUnit = grouped.get(aggregate.materialId);
        if (!byUnit) {
            byUnit = new Map<number, ReportItemDto>();
            grouped.set(aggregate.materialId, byUnit);
        }

        let unitGroup = byUnit.get(aggregate.unitId);
        if (!unitGroup) {
            unitGroup = { unit: aggregate.unit, allocatedQuantity: null, types: [] };
            byUnit.set(aggregate.unitId, unitGroup);
        }

        if (aggregate.allocatedQuantity !== null) {
            unitGroup.allocatedQuantity = (unitGroup.allocatedQuantity ?? 0) + aggregate.allocatedQuantity;
        }

        unitGroup.types.push(aggregate.type);
    }

    const materialIds = new Set<string>([
        ...grouped.keys(),
        ...reportCommentsByMaterial.keys(),
        ...allocatedQuantityByMaterial.keys(),
        ...quantityLeftToAllocateByMaterial.keys(),
    ]);

    const result: ReportDto[] = [];
    for (const materialId of materialIds) {
        const byUnit = grouped.get(materialId) ?? new Map<number, ReportItemDto>();
        const material = materialById.get(materialId) ?? buildMaterialDto(materialId);
        const comments = Array.from(reportCommentsByMaterial.get(materialId)?.entries() ?? [])
            .map(([type, comment]): ReportCommentDto => ({ type, comment }))
            .sort((a, b) => a.type - b.type);
        const items = Array.from(byUnit.values())
            .map((item) => ({
                ...item,
                types: item.types.sort((a, b) => a.id - b.id),
            }))
            .sort((a, b) => a.unit.id - b.unit.id);

        result.push({
            material,
            comments,
            receivedAllocationQuantity: allocatedQuantityByMaterial.get(materialId) ?? null,
            quantityLeftToAllocate: quantityLeftToAllocateByMaterial.get(materialId) ?? null,
            items,
        });
    }

    return result.sort((a, b) => a.material.id.localeCompare(b.material.id));
};

export const buildReportsMaterialsResponse = (params: FetchReportsParams): ReportDto[] =>
    buildReportsResponse(params);

const buildFavoriteItemTypes = (
    reportTypeIds: number[],
    unitId: number,
    materialId: string,
    yesterdayInventoryQuantityByUnitMaterial: Map<string, number>,
): ReportItemTypeDto[] =>
    reportTypeIds.map((reportTypeId) => ({
        id: reportTypeId,
        quantity: 0,
        availableQuantityToEat: 0,
        yesterdayInventoryQuantity: reportTypeId === REPORT_TYPES.INVENTORY
            ? (yesterdayInventoryQuantityByUnitMaterial.get(`${unitId}:${materialId}`) ?? 0)
            : null,
        comment: "",
        status: RECORD_STATUS.ACTIVE,
    }));

const buildFavoriteItems = (
    materialId: string,
    childrenUnits: UnitRelation[],
    reportTypeIds: number[],
    yesterdayInventoryQuantityByUnitMaterial: Map<string, number>,
): ReportItemDto[] =>
    childrenUnits.map((child) => {
        const parentUnit = buildUnitDto(
            child.unitId,
            child.unit?.activeDetail,
            null,
            undefined
        );

        return {
            unit: buildUnitDto(
                child.relatedUnitId,
                child.relatedUnit?.activeDetail,
                parentUnit,
                undefined
            ),
            allocatedQuantity: null,
            types: buildFavoriteItemTypes(
                reportTypeIds,
                child.relatedUnitId,
                materialId,
                yesterdayInventoryQuantityByUnitMaterial,
            ),
        };
    });

export const buildFavoriteReportsResponse = (
    materials: MaterialDto[] | null | undefined,
    childrenUnits: UnitRelation[],
    reportTypeIds: number[],
    yesterdayInventoryReports?: Report[] | null | undefined
): FavoriteReportDto[] => {
    if (!materials?.length) return [];

    const yesterdayInventoryQuantityByUnitMaterial = buildYesterdayInventoryQuantityByUnitMaterial(yesterdayInventoryReports);

    return materials
        .map((material) => ({
            material,
            items: buildFavoriteItems(
                material.id,
                childrenUnits,
                reportTypeIds.filter(reportTypeId =>
                    material.type === MATERIAL_TYPES.TOOL
                        ? reportTypeId === REPORT_TYPES.INVENTORY
                        : true
                ),
                yesterdayInventoryQuantityByUnitMaterial,
            ),
        }))
        .sort((a, b) => a.material.id.localeCompare(b.material.id));
};
