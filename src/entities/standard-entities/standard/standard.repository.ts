import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { Material } from "src/entities/material-entities/material/material.model";
import { getMaterialSupplyCenterTypeWhere } from "src/entities/material-entities/material/material-query.utils";
import { getReportableUnitTypeWhere } from "src/entities/unit-entities/unit/unit-query.utils";
import { Unit } from "src/entities/unit-entities/unit/unit.model";
import { UnitStatus } from "src/entities/unit-entities/units-statuses/units-statuses.model";
import { RelevantStandard, RelevantStandardValue } from "./standard.types";
import { StandardAttribute } from "../standard-attribute/standard-attribute.model";
import { UnitStandardTags } from "../unit-standard-tag/unit-standard-tag.model";
import { MaterialStandardGroup } from "../material-standard-group/material-standard-group.model";
import { CategoryDesc } from "../category-desc/category-desc.model";
import { CategoryGroup } from "../category-group/category-group.model";
import { StandardGroup } from "../standard-group/standard-group.model";
import { StandardTag } from "../standard-tag/standard-tag.model";
import { StandardValues } from "../standard-values/standard-values.model";

@Injectable()
export class StandardRepository {
    constructor(
        @InjectModel(StandardAttribute) private readonly standardAttributeModel: typeof StandardAttribute,
        @InjectModel(UnitStandardTags) private readonly unitStandardTagModel: typeof UnitStandardTags,
        @InjectModel(MaterialStandardGroup) private readonly materialStandardGroupModel: typeof MaterialStandardGroup,
        @InjectModel(CategoryDesc) private readonly categoryDescModel: typeof CategoryDesc,
        @InjectModel(CategoryGroup) private readonly categoryGroupModel: typeof CategoryGroup,
        @InjectModel(StandardGroup) private readonly standardGroupModel: typeof StandardGroup,
        @InjectModel(UnitStatus) private readonly unitStatusModel: typeof UnitStatus,
        @InjectModel(Material) private readonly materialModel: typeof Material,
        @InjectModel(Unit) private readonly unitModel: typeof Unit,
    ) { }

    async getUnitStandardTags(unitIds: number[]): Promise<Map<number, Map<number, string>>> {
        if (unitIds.length === 0) return new Map();

        const rows = await this.unitStandardTagModel.findAll({
            where: { unitId: { [Op.in]: unitIds } },
            include: [{
                model: StandardTag,
                as: "tag",
                attributes: ["id", "unitLevel", "tag"],
                required: true,
            }],
        });

        const result = new Map<number, Map<number, string>>();
        for (const row of rows) {
            if (!result.has(row.unitId)) {
                result.set(row.unitId, new Map());
            }
            if (row.tag) {
                result.get(row.unitId)!.set(row.tag.unitLevel, row.tag.tag);
            }
        }
        return result;
    }

    async getStandardsForItemGroups(itemGroupIds: string[]): Promise<RelevantStandard[]> {
        if (itemGroupIds.length === 0) return [];

        const attributes = await this.standardAttributeModel.findAll({
            where: { itemGroupId: { [Op.in]: itemGroupIds } },
            include: [
                {
                    model: StandardValues,
                    as: "values",
                    required: true,
                    include: [{
                        model: StandardTag,
                        as: "tag",
                        attributes: ["id", "unitLevel", "tag"],
                        required: true,
                    }],
                },
                {
                    model: StandardGroup,
                    as: "toolGroup",
                    required: false,
                    attributes: ["id", "name"],
                },
            ],
        });

        return attributes.flatMap((attr): RelevantStandard[] => {
            const values: RelevantStandardValue[] = (attr.values ?? []).map(v => ({
                tagId: v.tagId,
                tagLevel: v.tag!.unitLevel,
                tag: v.tag!.tag,
                quantity: v.quantity,
                note: v.note,
            }));

            const byLevel = new Map<number, RelevantStandardValue[]>();
            for (const v of values) {
                const list = byLevel.get(v.tagLevel) ?? [];
                list.push(v);
                byLevel.set(v.tagLevel, list);
            }

            const parallelLevel = Array.from(byLevel.entries()).find(([, vs]) => vs.length > 1)?.[0];

            if (parallelLevel === undefined) {
                const lowestLevel = values.reduce((max, v) => Math.max(max, v.tagLevel), 0);
                return [{
                    standardId: attr.id,
                    managingUnit: attr.managingUnit,
                    itemGroupId: attr.itemGroupId,
                    toolGroupId: attr.toolGroupId ?? null,
                    toolGroupName: attr.toolGroup?.name ?? null,
                    lowestLevel,
                    values,
                }];
            }

            const sharedValues = values.filter(v => v.tagLevel !== parallelLevel);
            const parallelValues = byLevel.get(parallelLevel)!;

            return parallelValues.map(branchValue => {
                const branchValues = [...sharedValues, branchValue];
                const lowestLevel = branchValues.reduce((max, v) => Math.max(max, v.tagLevel), 0);
                return {
                    standardId: attr.id,
                    managingUnit: attr.managingUnit,
                    itemGroupId: attr.itemGroupId,
                    toolGroupId: attr.toolGroupId ?? null,
                    toolGroupName: attr.toolGroup?.name ?? null,
                    lowestLevel,
                    values: branchValues,
                };
            });
        });
    }

    async getAllCategories(): Promise<{ groupToCategoryMap: Map<string, CategoryDesc>; categories: CategoryDesc[] }> {
        const categories = await this.categoryDescModel.findAll({
            include: [{
                model: CategoryGroup,
                as: "categoryGroups",
                attributes: ["id", "groupId"],
                required: false,
            }],
        });

        const groupToCategoryMap = new Map<string, CategoryDesc>();
        for (const cat of categories) {
            for (const cg of (cat.categoryGroups ?? [])) {
                groupToCategoryMap.set(cg.groupId, cat);
            }
        }

        return { groupToCategoryMap, categories };
    }

    async getAllItemGroupIds(): Promise<string[]> {
        const rows = await this.categoryGroupModel.findAll({ attributes: ["groupId"] });
        return rows.map(r => r.groupId);
    }

    async getAllGroupToMaterialMappings(): Promise<Map<string, string[]>> {
        const rows = await this.materialStandardGroupModel.findAll({
            attributes: ["groupId", "materialId"],
        });

        const mapping = new Map<string, string[]>();
        for (const row of rows) {
            if (!mapping.has(row.groupId)) {
                mapping.set(row.groupId, []);
            }
            mapping.get(row.groupId)!.push(row.materialId);
        }
        return mapping;
    }

    async getUnitStatusesForDate(unitIds: number[], date: string): Promise<Map<number, number>> {
        if (unitIds.length === 0) return new Map();

        const rows = await this.unitStatusModel.findAll({
            attributes: ["unitId", "unitStatusId"],
            where: {
                unitId: { [Op.in]: unitIds },
                date,
            },
        });

        const result = new Map<number, number>();
        for (const row of rows) {
            result.set(row.unitId, row.unitStatusId);
        }
        return result;
    }

    async getAllGroupNames(): Promise<Map<string, string>> {
        const rows = await this.standardGroupModel.findAll({
            attributes: ["id", "name"],
        });
        const result = new Map<string, string>();
        for (const row of rows) {
            result.set(row.id, row.name ?? row.id);
        }
        return result;
    }

    async getUnitDetails(date: string, unitIds: number[]): Promise<{ unitId: number; description: string | null; unitLevelId: number | null; simul: string | null }[]> {
        if (unitIds.length === 0) return [];

        const rows = await this.unitModel.findAll({
            attributes: ["unitId", "description", "unitLevelId", "tsavIrgunCodeId"],
            where: {
                unitId: { [Op.in]: unitIds },
                startDate: { [Op.lte]: date },
                endDate: { [Op.gt]: date },
                ...getReportableUnitTypeWhere(),
            },
            order: [["startDate", "DESC"]],
        });

        const seen = new Set<number>();
        const result: { unitId: number; description: string | null; unitLevelId: number | null; simul: string | null }[] = [];
        for (const row of rows) {
            if (!seen.has(row.unitId)) {
                seen.add(row.unitId);
                result.push({ unitId: row.unitId, description: row.description, unitLevelId: row.unitLevelId, simul: row.tsavIrgunCodeId });
            }
        }
        return result;
    }

    async getAllMaterials(): Promise<Map<string, string>> {
        const rows = await this.materialModel.findAll({
            attributes: ["id", "description"],
            where: getMaterialSupplyCenterTypeWhere(),
        });
        const result = new Map<string, string>();
        for (const row of rows) {
            result.set(row.id, row.description ?? row.id);
        }
        return result;
    }
}
