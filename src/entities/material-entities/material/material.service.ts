import { Injectable } from "@nestjs/common";
import { isEmptyish } from "remeda";
import { ReportCommentDto } from "src/entities/report-entities/report/report.types";
import { MATERIAL_TYPES } from "../../../constants";
import { Material } from "./material.model";
import { MaterialRepository } from "./material.repository";
import { PastedMaterialsDto } from "./material.types";
import { StandardGroup } from "src/entities/standard-entities/standard-group/standard-group.model";

const getMaterialCategory = (material: Material) => {
    const type = material.dataValues.type;

    if (type === MATERIAL_TYPES.TOOL) {
        return material.standardGroupMaterials
            ?.find((standardGroupMaterial) => standardGroupMaterial.standardGroup?.categoryGroup?.categoryDesc?.description)
            ?.standardGroup?.categoryGroup?.categoryDesc?.description ?? "כללי";
    }

    return material.materialCategory?.mainCategory?.dataValues?.description ?? 'כללי';
};

const getGroupCategory = (group: StandardGroup) =>
    group.categoryGroup?.categoryDesc?.description ?? 'כללי'

@Injectable()
export class MaterialService {
    constructor(private readonly repository: MaterialRepository) { }

    async fetchExcelMaterials() {
        const { materials, standardGroups } = await this.repository.fetchExcelMaterials();

        const standardGroupResults = standardGroups.map((group) => ({
            id: group.id,
            description: group.name,
            unitOfMeasure: 'יח',
            multiply: 0,
            nickname: group.nickname?.nickname ?? "",
            category: getGroupCategory(group),
            type: group.groupType,
        }));

        const materialsResults = materials.map((material) => ({
            id: material.dataValues.id,
            description: material.dataValues.description,
            unitOfMeasure: material.dataValues.unitOfMeasurement,
            multiply: material.dataValues.multiply,
            nickname: material.nickname?.dataValues.nickname,
            category: getMaterialCategory(material),
            type: material.dataValues.type
        }));

        return [...materialsResults, ...standardGroupResults];
    }

    async fetchTwenty(filter: string, unitId: number) {
        const { materials, comments, standardGroups, favoriteIds } = await this.repository.fetchBySearch(filter, unitId);
        const reportCommentsByMaterial = new Map<string, Map<number, string>>();

        for (const comment of comments) {
            let commentsByType = reportCommentsByMaterial.get(comment.materialId);
            if (!commentsByType) {
                commentsByType = new Map<number, string>();
                reportCommentsByMaterial.set(comment.materialId, commentsByType);
            }

            if (!commentsByType.has(comment.type)) {
                commentsByType.set(comment.type, comment.text ?? '');
            }
        }

        const materialResults = materials.map(material => ({
            ...material.dataValues,
            unitOfMeasure: material.dataValues.unitOfMeasurement,
            multiply: Number(material.dataValues.multiply),
            category: getMaterialCategory(material),
            nickname: material.nickname?.nickname ?? "",
            type: material.dataValues.type,
            favorite: !isEmptyish(material.unitFavorites ?? []),
            comments: Array.from(reportCommentsByMaterial.get(material.id)?.entries() ?? [])
                .map(([type, comment]): ReportCommentDto => ({ type, comment }))
                .sort((a, b) => a.type - b.type)
        }));

        const standardGroupResults: Array<Record<string, any>> = standardGroups.map((group) => ({
            id: group.id,
            description: group.name,
            favorite: favoriteIds.has(group.id),
            type: group.groupType,
            category: getGroupCategory(group),
            nickname: group.nickname?.nickname ?? "",
            unitOfMeasure: 'יח',
            multiply: 0,
            comments: Array.from(reportCommentsByMaterial.get(group.id)?.entries() ?? [])
                .map(([type, comment]): ReportCommentDto => ({ type, comment }))
                .sort((a, b) => a.type - b.type)
        }));

        return [...materialResults, ...standardGroupResults]
            .sort((a, b) => {
                if (a.favorite !== b.favorite) {
                    return a.favorite ? -1 : 1;
                }
                return String(a.id).localeCompare(String(b.id));
            })
            .slice(0, 20);
    }

    async fetchByIds(pastedMaterials: PastedMaterialsDto, screenUnitId: number) {
        const { materials, standardGroups, favoriteIds } = await this.repository.fetchByIds(
            pastedMaterials.materialsIds,
            screenUnitId,
        );

        const materialResults = materials.map(material => ({
            ...material.dataValues,
            unitOfMeasure: material.dataValues.unitOfMeasurement,
            multiply: Number(material.dataValues.multiply),
            category: getMaterialCategory(material),
            nickname: material.nickname?.nickname ?? "",
            type: material.dataValues.type,
            favorite: !isEmptyish(material.unitFavorites ?? []),
        }));
        const standardGroupResults: Array<Record<string, any>> = standardGroups.map((group) => ({
            id: group.id,
            description: group.name,
            favorite: favoriteIds.has(group.id),
            type: group.groupType,
            category: getGroupCategory(group),
            nickname: group.nickname?.nickname ?? "",
            unitOfMeasure: null,
            multiply: 0,
        }));

        return [...materialResults, ...standardGroupResults]
            .sort((a, b) => {
                if (a.favorite !== b.favorite) {
                    return a.favorite ? -1 : 1;
                }
                return String(a.id).localeCompare(String(b.id));
            })
    }
}
