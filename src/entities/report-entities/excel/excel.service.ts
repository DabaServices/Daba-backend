import { BadRequestException, Injectable } from "@nestjs/common";
import Decimal from "decimal.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { MATERIAL_TYPES, MESSAGE_TYPES, RECORD_STATUS, REPORT_TYPES, UNIT_LEVELS, UNIT_STATUSES } from "../../../constants";
import { MaterialRepository } from "../../material-entities/material/material.repository";
import { UnitHierarchyRepository, UnitLookupRow } from "../../unit-entities/features/unit-hierarchy/unit-hierarchy.repository";
import { UnitRelation } from "../../unit-entities/unit-relations/unit-relation.model";
import { getEmergencyUnitIds } from "../../unit-entities/features/unit-hierarchy/utilities/hierarchyRecursion";
import { ReportRepository } from "../report/report.repository";
import { ReportService } from "../report/report.service";
import type { MaterialDto, ReportDto, ReportItemDto, ReportItemTypeDto, UnitDto } from "../report/report.types";
import {
    ExcelImportBody,
    ExcelImportChange,
    ExcelImportFailure,
    NormalizedExcelRow,
    NormalizedScreenRow,
    ValidExcelRow,
} from "./excel.types";

type MaterialImportRow = {
    id: string;
    description: string;
    multiply: number;
    recordStatus: string;
    type: string;
    centerId?: number;
    unitOfMeasurement?: string;
    isStandardGroup?: boolean;
    nickname?: {
        nickname?: string;
    };
    materialCategory?: {
        mainCategory?: {
            description?: string;
        };
    };
    standardGroupMaterials?: Array<{
        standardGroup?: {
            categoryGroup?: {
                categoryDesc?: {
                    description?: string;
                };
            };
        };
    }>;
    categoryGroup?: {
        categoryDesc?: {
            description?: string;
        };
    };
};

type HierarchyUnitSnapshot = {
    unitId: number;
    description: string;
    level: number;
    simul: string;
    statusId: number;
    statusDescription: string;
};

type ImportScope = {
    unitById: Map<number, HierarchyUnitSnapshot>;
    unitBySimul: Map<string, HierarchyUnitSnapshot>;
    parentByChild: Map<number, number>;
    descendantUnitIds: number[];
    includedUnitIds: number[];
    lowerUnitIds: number[];
    gdudUnitIds: number[];
};

const SUPPORTED_REPORT_TYPES = new Set<number>([
    REPORT_TYPES.REQUEST,
    REPORT_TYPES.INVENTORY,
    REPORT_TYPES.USAGE,
]);

const DEFAULT_FAILURE_MESSAGE = "נמצאו שגיאות בייבוא האקסל";
const SCREEN_UNIT_NOT_FOUND_MESSAGE = "יחידת המסך לא קיימת במערכת";
const UNSUPPORTED_REPORT_TYPE_MESSAGE = "סוג הדיווח אינו נתמך בייבוא האקסל";
const MATERIAL_NOT_FOUND_MESSAGE = "המק\"ט לא קיים במערכת";
const MATERIAL_INACTIVE_MESSAGE = "המק\"ט אינו פעיל";
const QUANTITY_MUST_BE_POSITIVE_MESSAGE = "הכמות חייבת להיות גדולה מ-0";
const UNIT_NOT_FOUND_MESSAGE = "היחידה לא קיימת במערכת";
const SCREEN_ROWS_OUTSIDE_SCREEN_UNIT_MESSAGE = "נתוני המסך מכילים יחידות שאינן תחת יחידת המסך";
const UNIT_OUTSIDE_OPEN_BRANCHES_MESSAGE = "היחידה אינה תחת הילדים הפתוחים של יחידת המסך";
const UNIT_STATUS_INVALID_MESSAGE = "היחידה חייבת להיות בסטטוס ממתין להקצאה";
const INVENTORY_USAGE_LEVEL_MESSAGE = "עבור מלאי ושימוש ניתן לייבא רק יחידות ברמת גדוד";
const REQUEST_LEVEL_MESSAGE = "עבור דרישה היחידה חייבת להיות נמוכה מיחידת המסך";
const TEMPLATE_FILE_NAME = "template.xlsm";
const TEMPLATE_MIME_TYPE = "application/vnd.ms-excel.sheet.macroEnabled.12";

export const filterRegularUnitRequisitions = (
    rows: ValidExcelRow[],
    emergencyUnitIds: Set<number>
) => rows.filter((row) =>
    row.reportType !== REPORT_TYPES.REQUEST || emergencyUnitIds.has(row.unitId)
);

@Injectable()
export class ExcelService {
    constructor(
        private readonly materialRepository: MaterialRepository,
        private readonly reportRepository: ReportRepository,
        private readonly unitHierarchyRepository: UnitHierarchyRepository,
        private readonly reportService: ReportService,
    ) { }

    async downloadTemplate() {
        const templatePath = join(__dirname, TEMPLATE_FILE_NAME);
        const buffer = await readFile(templatePath);

        return {
            buffer,
            fileName: TEMPLATE_FILE_NAME,
            mimeType: TEMPLATE_MIME_TYPE,
        };
    }

    async exportAllocationDuh(date: string, screenUnitId: number, materialId?: string) {
        const data = await this.reportService.fetchAllocationDuhExport(date, screenUnitId, materialId);

        if (!data) {
            return {
                data: null,
                message: "אין הקצאות לייצוא",
                type: MESSAGE_TYPES.WARNING,
            };
        }

        return {
            data,
            message: "אקסל הקצאה דו״ה הופק בהצלחה",
            type: MESSAGE_TYPES.SUCCESS,
        };
    }

    async importExcelRows(
        date: string,
        screenUnitId: number,
        excelImportBody: ExcelImportBody
    ) {
        const excelRows = excelImportBody.excelRows ?? [];

        if (excelRows.length === 0) {
            return this.buildResponse([], []);
        }

        const screenRows = excelImportBody?.screenRows ?? [];

        const materialIds = Array.from(new Set([
            ...excelRows.map((row) => row.materialId),
            ...screenRows.map((row) => row.materialId),
        ]));

        const unitSimuls = Array.from(new Set(excelRows.map((row) => row.unitSimul).filter(Boolean)));
        const screenRowUnitIds = Array.from(new Set([
            screenUnitId,
            ...screenRows.map((row) => row.unitId).filter((unitId) => Number.isFinite(unitId)),
        ]));

        const [materials, unitLookupRows, activeRelations] = await Promise.all([
            this.materialRepository.fetchMaterialsForExcelImport(materialIds),
            this.unitHierarchyRepository.fetchUnitsForExcelImport(date, {
                unitIds: screenRowUnitIds,
                unitSimuls,
            }),
            this.unitHierarchyRepository.fetchActive(date) as Promise<UnitRelation[]>,
        ]);

        const materialById = this.buildMaterialByIdMap(materials as unknown as MaterialImportRow[]);
        const importScope = this.buildImportScope(screenUnitId, unitLookupRows, activeRelations);
        const screenUnit = importScope.unitById.get(screenUnitId);

        if (!screenUnit) {
            throw new BadRequestException({
                message: SCREEN_UNIT_NOT_FOUND_MESSAGE,
                type: MESSAGE_TYPES.FAILURE,
            });
        }

        this.validateScreenRows(screenRows, importScope, screenUnitId);

        const { validRows, failures } = this.validateExcelRows(
            excelRows,
            materialById,
            importScope,
            screenUnit
        );
        const emergencyRequisitionRows = filterRegularUnitRequisitions(
            validRows,
            getEmergencyUnitIds(activeRelations)
        );

        if (emergencyRequisitionRows.length === 0) {
            return this.buildResponse([], failures);
        }

        const combinedValidRows = this.combineDuplicateExcelRows(emergencyRequisitionRows);

        const affectedMaterialsByReportType = this.buildAffectedMaterialsByReportType(combinedValidRows);
        const affectedReportTypes = Array.from(affectedMaterialsByReportType.keys()).sort((left, right) => left - right);
        const dbUnitIds = this.collectDbUnitIds(affectedReportTypes, importScope);
        const dbMaterialIds = Array.from(new Set(combinedValidRows.map((row) => row.materialId)));

        const dbRows = await this.reportRepository.fetchActiveReportItemQuantitiesByUnitMaterialAndType(
            date,
            affectedReportTypes,
            dbMaterialIds,
            dbUnitIds
        );

        const flatChanges = this.buildChanges({
            validRows: combinedValidRows,
            screenRows,
            dbRows,
            affectedMaterialsByReportType,
            importScope,
            screenUnitId,
        });

        const changes = this.buildReportFetchLikeChanges(
            flatChanges,
            materialById,
            importScope
        );

        return this.buildResponse(changes, failures);
    }

    private combineDuplicateExcelRows(excelRows: ValidExcelRow[]): ValidExcelRow[] {
        const rowsByKey = new Map<string, ValidExcelRow>();

        for (const row of excelRows) {
            const rowKey = this.buildExcelDuplicateKey(row);
            const existing = rowsByKey.get(rowKey);

            if (!existing) {
                rowsByKey.set(rowKey, { ...row });
                continue;
            }

            existing.quantity += row.quantity;
            existing.rowNumber = Math.min(existing.rowNumber, row.rowNumber);
        }

        return Array.from(rowsByKey.values()).sort((left, right) => left.rowNumber - right.rowNumber);
    }

    private buildMaterialByIdMap(materials: MaterialImportRow[]): Map<string, MaterialImportRow> {
        const materialById = new Map<string, MaterialImportRow>();

        for (const material of materials) {
            materialById.set(material.id, {
                id: material.id,
                description: material.description,
                multiply: Number(material.multiply),
                recordStatus: material.recordStatus,
                type: material.type,
                centerId: material.centerId,
                unitOfMeasurement: material.unitOfMeasurement,
                isStandardGroup: material.isStandardGroup,
                nickname: material.nickname,
                materialCategory: material.materialCategory,
                standardGroupMaterials: material.standardGroupMaterials,
                categoryGroup: material.categoryGroup,
            });
        }

        return materialById;
    }

    private buildImportScope(
        screenUnitId: number,
        unitLookupRows: UnitLookupRow[],
        activeRelations: UnitRelation[]
    ): ImportScope {
        const unitById = new Map<number, HierarchyUnitSnapshot>();
        const childrenByParent = new Map<number, number[]>();
        const parentsByChild = new Map<number, number[]>();

        for (const unitLookupRow of unitLookupRows) {
            this.upsertUnitSnapshot(unitById, {
                unitId: unitLookupRow.unitId,
                description: unitLookupRow.description ?? "",
                level: unitLookupRow.unitLevelId ?? 0,
                simul: unitLookupRow.simul ?? "",
                statusId: unitLookupRow.statusId,
                statusDescription: unitLookupRow.statusDescription ?? "",
            });
        }

        for (const relation of activeRelations) {
            const parentId = relation.unitId;
            const childId = relation.relatedUnitId;

            childrenByParent.set(parentId, [
                ...(childrenByParent.get(parentId) ?? []),
                childId,
            ]);
            parentsByChild.set(childId, [
                ...(parentsByChild.get(childId) ?? []),
                parentId,
            ]);

            this.upsertUnitSnapshot(
                unitById,
                this.buildHierarchyUnitSnapshotFromRelationSource(parentId, relation.unit)
            );
            this.upsertUnitSnapshot(
                unitById,
                this.buildHierarchyUnitSnapshotFromRelationSource(childId, relation.relatedUnit)
            );
        }

        const descendantUnitIds = new Set<number>();
        const descendantQueue = [...this.sortNumeric(childrenByParent.get(screenUnitId) ?? [])];

        while (descendantQueue.length > 0) {
            const currentUnitId = descendantQueue.shift();
            if (currentUnitId === undefined || descendantUnitIds.has(currentUnitId)) continue;

            descendantUnitIds.add(currentUnitId);

            for (const childUnitId of childrenByParent.get(currentUnitId) ?? []) {
                if (descendantUnitIds.has(childUnitId)) continue;
                descendantQueue.push(childUnitId);
            }
        }

        const directChildIds = this.sortNumeric(childrenByParent.get(screenUnitId) ?? []);
        const openDirectChildIds = directChildIds.filter(
            (childUnitId) => (unitById.get(childUnitId)?.statusId ?? 0) === UNIT_STATUSES.WAITING_FOR_ALLOCATION
        );

        const includedUnitIds = new Set<number>([screenUnitId]);
        const queue = [...openDirectChildIds];

        while (queue.length > 0) {
            const currentUnitId = queue.shift();
            if (currentUnitId === undefined || includedUnitIds.has(currentUnitId)) continue;

            includedUnitIds.add(currentUnitId);

            for (const childUnitId of childrenByParent.get(currentUnitId) ?? []) {
                if (includedUnitIds.has(childUnitId)) continue;
                queue.push(childUnitId);
            }
        }

        const includedUnitIdsSorted = this.sortNumeric(Array.from(includedUnitIds));
        const parentByChild = new Map<number, number>();

        for (const unitId of includedUnitIdsSorted) {
            if (unitId === screenUnitId) continue;

            const directParentId = this.sortNumeric(
                (parentsByChild.get(unitId) ?? []).filter((parentUnitId) => includedUnitIds.has(parentUnitId))
            )[0];

            if (directParentId !== undefined) {
                parentByChild.set(unitId, directParentId);
            }
        }

        const unitBySimul = new Map<string, HierarchyUnitSnapshot>();
        for (const unit of unitById.values()) {
            if (!unit.simul || unitBySimul.has(unit.simul)) continue;
            unitBySimul.set(unit.simul, unit);
        }

        const lowerUnitIds = includedUnitIdsSorted.filter((unitId) => unitId !== screenUnitId);
        const gdudUnitIds = lowerUnitIds.filter(
            (unitId) => (unitById.get(unitId)?.level ?? -1) === UNIT_LEVELS.GDUD
        );

        return {
            unitById,
            unitBySimul,
            parentByChild,
            descendantUnitIds: this.sortNumeric(Array.from(descendantUnitIds)),
            includedUnitIds: includedUnitIdsSorted,
            lowerUnitIds,
            gdudUnitIds,
        };
    }

    private validateScreenRows(
        screenRows: NormalizedScreenRow[],
        importScope: ImportScope,
        screenUnitId: number
    ) {
        const descendantUnitIds = new Set(importScope.descendantUnitIds);
        const invalidUnitIds = this.sortNumeric(Array.from(new Set(
            screenRows
                .map((row) => row.unitId)
                .filter((unitId) => !descendantUnitIds.has(unitId) || unitId === screenUnitId)
        )));

        if (invalidUnitIds.length === 0) return;

        throw new BadRequestException({
            message: `${SCREEN_ROWS_OUTSIDE_SCREEN_UNIT_MESSAGE}: ${invalidUnitIds.join(", ")}`,
            type: MESSAGE_TYPES.FAILURE,
        });
    }

    private validateExcelRows(
        excelRows: NormalizedExcelRow[],
        materialById: Map<string, MaterialImportRow>,
        importScope: ImportScope,
        screenUnit: HierarchyUnitSnapshot
    ): { validRows: ValidExcelRow[]; failures: ExcelImportFailure[] } {
        const validRows: ValidExcelRow[] = [];
        const failures: ExcelImportFailure[] = [];
        const includedUnitIds = new Set(importScope.includedUnitIds);

        for (const row of excelRows) {
            const material = materialById.get(row.materialId);
            const unit = importScope.unitBySimul.get(row.unitSimul);
            const errorMessages = this.collectExcelRowErrorMessages(
                row,
                material,
                unit,
                includedUnitIds,
                screenUnit
            );

            if (errorMessages.length > 0) {
                failures.push(
                    ...errorMessages.map((errorMessage) => this.buildFailure(row, errorMessage, material, unit))
                );
                continue;
            }

            validRows.push({
                ...row,
                unitId: unit!.unitId,
            });
        }

        return {
            validRows,
            failures: failures
        };
    }

    private collectExcelRowErrorMessages(
        row: NormalizedExcelRow,
        material: MaterialImportRow | undefined,
        unit: HierarchyUnitSnapshot | undefined,
        includedUnitIds: Set<number>,
        screenUnit: HierarchyUnitSnapshot
    ): string[] {
        const errorMessages: string[] = [];
        const isSupportedReportType = SUPPORTED_REPORT_TYPES.has(row.reportType);

        if (!isSupportedReportType) {
            errorMessages.push(UNSUPPORTED_REPORT_TYPE_MESSAGE);
        }

        if (!material) {
            errorMessages.push(MATERIAL_NOT_FOUND_MESSAGE);
        } else {
            if (material.recordStatus !== RECORD_STATUS.ACTIVE) {
                errorMessages.push(MATERIAL_INACTIVE_MESSAGE);
            }
        }

        if (row.quantity < 0) {
            errorMessages.push(QUANTITY_MUST_BE_POSITIVE_MESSAGE);
        }

        if (!unit) {
            errorMessages.push(UNIT_NOT_FOUND_MESSAGE);
        } else {
            if (!includedUnitIds.has(unit.unitId) || unit.unitId === screenUnit.unitId) {
                errorMessages.push(UNIT_OUTSIDE_OPEN_BRANCHES_MESSAGE);
            }

            if (unit.statusId !== UNIT_STATUSES.WAITING_FOR_ALLOCATION) {
                errorMessages.push(UNIT_STATUS_INVALID_MESSAGE);
            }

            if (
                isSupportedReportType &&
                (row.reportType === REPORT_TYPES.INVENTORY || row.reportType === REPORT_TYPES.USAGE) &&
                unit.level !== UNIT_LEVELS.GDUD
            ) {
                errorMessages.push(INVENTORY_USAGE_LEVEL_MESSAGE);
            }

            if (
                isSupportedReportType &&
                row.reportType === REPORT_TYPES.REQUEST &&
                unit.level <= screenUnit.level
            ) {
                errorMessages.push(REQUEST_LEVEL_MESSAGE);
            }
        }

        return errorMessages;
    }

    private buildAffectedMaterialsByReportType(validRows: ValidExcelRow[]): Map<number, Set<string>> {
        const materialsByReportType = new Map<number, Set<string>>();

        for (const row of validRows) {
            const materials = materialsByReportType.get(row.reportType) ?? new Set<string>();
            materials.add(row.materialId);
            materialsByReportType.set(row.reportType, materials);
        }

        return materialsByReportType;
    }

    private collectDbUnitIds(
        reportTypes: number[],
        importScope: ImportScope
    ): number[] {
        const unitIds = new Set<number>();

        for (const reportType of reportTypes) {
            for (const unitId of this.getBaseUnitIdsForReportType(reportType, importScope)) {
                unitIds.add(unitId);
            }
        }

        return this.sortNumeric(Array.from(unitIds));
    }

    private buildChanges({
        validRows,
        screenRows,
        dbRows,
        affectedMaterialsByReportType,
        importScope,
        screenUnitId,
    }: {
        validRows: ValidExcelRow[];
        screenRows: NormalizedScreenRow[];
        dbRows: Array<{ unitId: number; materialId: string; reportTypeId: number; quantity: number }>;
        affectedMaterialsByReportType: Map<number, Set<string>>;
        importScope: ImportScope;
        screenUnitId: number;
    }): ExcelImportChange[] {
        const excelQuantityByKey = new Map<string, number>();
        const screenQuantityByKey = new Map<string, number>();
        const dbQuantityByKey = new Map<string, number>();

        for (const row of validRows) {
            excelQuantityByKey.set(
                this.buildUnitMaterialReportKey(row.reportType, row.unitId, row.materialId),
                row.quantity
            );
        }

        for (const row of screenRows) {
            screenQuantityByKey.set(
                this.buildUnitMaterialReportKey(row.reportType, row.unitId, row.materialId),
                row.quantity
            );
        }

        for (const row of dbRows) {
            dbQuantityByKey.set(
                this.buildUnitMaterialReportKey(row.reportTypeId, row.unitId, row.materialId),
                row.quantity
            );
        }

        const aggregatedChangeByKey = new Map<string, ExcelImportChange>();

        for (const [reportType, materialIds] of affectedMaterialsByReportType.entries()) {
            const baseUnitIds = this.getBaseUnitIdsForReportType(reportType, importScope);

            for (const materialId of materialIds) {
                for (const baseUnitId of baseUnitIds) {
                    const quantityKey = this.buildUnitMaterialReportKey(reportType, baseUnitId, materialId);
                    const quantity = excelQuantityByKey.get(quantityKey)
                        ?? screenQuantityByKey.get(quantityKey)
                        ?? dbQuantityByKey.get(quantityKey)
                        ?? 0;

                    if (!(quantity > 0)) continue;

                    this.upsertChange(
                        aggregatedChangeByKey,
                        reportType,
                        baseUnitId,
                        materialId,
                        quantity
                    );

                    let currentParentId = importScope.parentByChild.get(baseUnitId);
                    while (currentParentId !== undefined) {
                        if (currentParentId === screenUnitId) break;

                        this.upsertChange(
                            aggregatedChangeByKey,
                            reportType,
                            currentParentId,
                            materialId,
                            quantity
                        );

                        currentParentId = importScope.parentByChild.get(currentParentId);
                    }
                }
            }
        }

        return Array.from(aggregatedChangeByKey.values()).sort((left, right) => {
            if (left.reportType !== right.reportType) {
                return left.reportType - right.reportType;
            }

            if (left.unitId !== right.unitId) {
                return left.unitId - right.unitId;
            }

            return left.materialId.localeCompare(right.materialId);
        });
    }

    private buildFailure(
        row: NormalizedExcelRow,
        errorMessage: string,
        material?: MaterialImportRow,
        unit?: HierarchyUnitSnapshot
    ): ExcelImportFailure {
        const rowNumber = Number.isFinite(row.rowNumber) ? row.rowNumber : 0;

        return {
            reportType: Number.isFinite(row.reportType) ? row.reportType : -1,
            materialId: row.materialId,
            unitSimul: row.unitSimul,
            quantity: Number.isFinite(row.quantity) ? row.quantity : 0,
            materialDesc: material?.description ?? "",
            unitDesc: unit?.description ?? "",
            rowNumber,
            errorMessage: `${errorMessage} בשורה ${rowNumber}`,
        };
    }

    private buildReportFetchLikeChanges(
        changes: ExcelImportChange[],
        materialById: Map<string, MaterialImportRow>,
        importScope: ImportScope
    ): ReportDto[] {
        const itemsByMaterial = new Map<string, Map<number, ReportItemDto>>();

        for (const change of changes) {
            let byUnit = itemsByMaterial.get(change.materialId);
            if (!byUnit) {
                byUnit = new Map<number, ReportItemDto>();
                itemsByMaterial.set(change.materialId, byUnit);
            }

            let unitItem = byUnit.get(change.unitId);
            if (!unitItem) {
                unitItem = {
                    unit: this.buildUnitDto(change.unitId, importScope),
                    allocatedQuantity: null,
                    types: [],
                };
                byUnit.set(change.unitId, unitItem);
            }

            unitItem.types.push(this.buildReportItemTypeDto(change));
        }

        return Array.from(itemsByMaterial.entries())
            .map(([materialId, byUnit]): ReportDto => ({
                material: this.buildMaterialDto(materialId, materialById.get(materialId)),
                comments: [],
                receivedAllocationQuantity: null,
                quantityLeftToAllocate: null,
                items: Array.from(byUnit.values())
                    .map((item) => ({
                        ...item,
                        types: item.types.sort((left, right) => left.id - right.id),
                    }))
                    .sort((left, right) => left.unit.id - right.unit.id),
            }))
            .sort((left, right) => left.material.id.localeCompare(right.material.id));
    }

    private buildMaterialDto(materialId: string, material?: MaterialImportRow): MaterialDto {
        return {
            id: materialId,
            description: material?.description ?? "",
            multiply: Number(material?.multiply ?? 0),
            nickname: material?.nickname?.nickname ?? "",
            category: this.getMaterialCategory(material),
            unitOfMeasure: material?.unitOfMeasurement ?? "",
            type: material?.type ?? MATERIAL_TYPES.ITEM,
        };
    }

    private getMaterialCategory(material?: MaterialImportRow) {
        if (!material) return "";

        if (material.isStandardGroup) {
            return material.categoryGroup?.categoryDesc?.description ?? "";
        }

        if (material.type === MATERIAL_TYPES.TOOL) {
            return material.standardGroupMaterials
                ?.find((standardGroupMaterial) => standardGroupMaterial.standardGroup?.categoryGroup?.categoryDesc?.description)
                ?.standardGroup?.categoryGroup?.categoryDesc?.description ?? "";
        }

        return material.materialCategory?.mainCategory?.description ?? "";
    }

    private buildUnitDto(unitId: number, importScope: ImportScope): UnitDto {
        const unit = importScope.unitById.get(unitId);
        const parentUnitId = importScope.parentByChild.get(unitId);
        const parent = parentUnitId ? this.buildParentUnitDto(parentUnitId, importScope) : null;

        return {
            id: unitId,
            description: unit?.description ?? "",
            level: unit?.level ?? 0,
            simul: unit?.simul ?? "",
            parent,
            status: {
                id: unit?.statusId ?? 0,
                description: unit?.statusDescription ?? "",
            },
        };
    }

    private buildParentUnitDto(unitId: number, importScope: ImportScope): UnitDto {
        const unit = importScope.unitById.get(unitId);

        return {
            id: unitId,
            description: unit?.description ?? "",
            level: unit?.level ?? 0,
            simul: unit?.simul ?? "",
            parent: null,
            status: {
                id: unit?.statusId ?? 0,
                description: unit?.statusDescription ?? "",
            },
        };
    }

    private buildReportItemTypeDto(change: ExcelImportChange): ReportItemTypeDto {
        return {
            id: change.reportType,
            quantity: change.quantity,
            availableQuantityToEat: 0,
            yesterdayInventoryQuantity: change.reportType === REPORT_TYPES.INVENTORY ? 0 : null,
            comment: "",
            status: RECORD_STATUS.ACTIVE,
        };
    }

    private buildResponse(changes: ReportDto[], failures: ExcelImportFailure[]) {
        if (changes.length === 0 && failures.length === 0) {
            return {
                message: 'לא הועלה אקסל',
                type: MESSAGE_TYPES.FAILURE
            };
        }

        if (changes.length === 0 && failures.length > 0) {
            return {
                data: { changes, failures },
                message: "האקסל לא הועלה, מורד אקסל שגויים",
                type: MESSAGE_TYPES.FAILURE,
            };
        }

        if (changes.length > 0 && failures.length > 0) {
            return {
                data: { changes, failures },
                message: "האקסל עלה עם שגיאות, יש להסתכל על האקסל שגויים",
                type: MESSAGE_TYPES.WARNING,
            };
        }

        return {
            data: { changes, failures },
            message: changes.length > 0 ? "האקסל הועלה בהצלחה" : DEFAULT_FAILURE_MESSAGE,
            type: changes.length > 0 ? MESSAGE_TYPES.SUCCESS : MESSAGE_TYPES.FAILURE,
        };
    }

    private buildExcelDuplicateKey(row: NormalizedExcelRow): string {
        return `${row.reportType}:${row.unitSimul}:${row.materialId}`;
    }

    private buildUnitMaterialReportKey(reportType: number, unitId: number, materialId: string): string {
        return `${reportType}:${unitId}:${materialId}`;
    }

    private upsertChange(
        aggregatedChangeByKey: Map<string, ExcelImportChange>,
        reportType: number,
        unitId: number,
        materialId: string,
        quantity: number
    ) {
        const changeKey = this.buildUnitMaterialReportKey(reportType, unitId, materialId);
        const existing = aggregatedChangeByKey.get(changeKey);

        if (existing) {
            existing.quantity += quantity;
            return;
        }

        aggregatedChangeByKey.set(changeKey, {
            reportType,
            materialId,
            unitId,
            quantity,
        });
    }

    private getBaseUnitIdsForReportType(reportType: number, importScope: ImportScope): number[] {
        if (reportType === REPORT_TYPES.REQUEST) {
            return importScope.lowerUnitIds;
        }

        if (reportType === REPORT_TYPES.INVENTORY || reportType === REPORT_TYPES.USAGE) {
            return importScope.gdudUnitIds;
        }

        return [];
    }

    private isQuantityInMaterialMultiples(quantity: number, multiply: number): boolean {
        return new Decimal(quantity).modulo(new Decimal(multiply)).isZero()
    }

    private buildHierarchyUnitSnapshotFromRelationSource(
        unitId: number,
        source?: {
            activeDetail?: {
                dataValues?: {
                    description?: string | null;
                    unitLevelId?: number | null;
                    tsavIrgunCodeId?: string | null;
                };
            };
            details?: Array<{
                dataValues?: {
                    description?: string | null;
                    unitLevelId?: number | null;
                    tsavIrgunCodeId?: string | null;
                };
            }>;
            unitStatus?: Array<{
                unitStatus?: {
                    dataValues?: {
                        id: number;
                        description: string;
                    };
                    id?: number;
                    description?: string;
                };
            }>;
        }
    ): HierarchyUnitSnapshot {
        const detail = source?.activeDetail?.dataValues ?? source?.details?.[0]?.dataValues;
        const status = source?.unitStatus?.[0]?.unitStatus;
        const statusValues = status?.dataValues ?? {
            id: status?.id ?? 0,
            description: status?.description ?? "",
        };

        return {
            unitId,
            description: detail?.description ?? "",
            level: detail?.unitLevelId ?? 0,
            simul: detail?.tsavIrgunCodeId ?? "",
            statusId: statusValues.id ?? 0,
            statusDescription: statusValues.description ?? "",
        };
    }

    private upsertUnitSnapshot(
        unitById: Map<number, HierarchyUnitSnapshot>,
        snapshot: HierarchyUnitSnapshot
    ) {
        const existing = unitById.get(snapshot.unitId);
        if (!existing) {
            unitById.set(snapshot.unitId, snapshot);
            return;
        }

        unitById.set(snapshot.unitId, {
            unitId: snapshot.unitId,
            description: existing.description || snapshot.description,
            level: existing.level || snapshot.level,
            simul: existing.simul || snapshot.simul,
            statusId: existing.statusId || snapshot.statusId,
            statusDescription: existing.statusDescription || snapshot.statusDescription,
        });
    }

    private sortNumeric(values: number[]): number[] {
        return Array.from(new Set(values)).sort((left, right) => left - right);
    }
}
