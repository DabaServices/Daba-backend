import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { CategoryDesc } from "src/entities/standard-entities/category-desc/category-desc.model";
import { CategoryGroup } from "src/entities/standard-entities/category-group/category-group.model";
import { MATERIAL_TYPES, RECORD_STATUS, REPORT_TYPES } from "../../../constants";
import { Comment } from "../../report-entities/comment/comment.model";
import { MaterialStandardGroup } from "../../standard-entities/material-standard-group/material-standard-group.model";
import { StandardGroup } from "../../standard-entities/standard-group/standard-group.model";
import { MainCategory } from "../categories/categories.model";
import { MaterialCategory } from "../material-category/material-category.model";
import { MaterialNickname } from "../material-nickname/material-nickname.model";
import { UnitFavoriteMaterial } from "../unit-favorite-material/unit-favorite-material.model";
import { getActiveToolStandardGroupConstraint, getMaterialSupplyCenterTypeWhere } from "./material-query.utils";
import { Material } from "./material.model";

const getMaterialStandardGroupInclude = () => ({
    attributes: ["groupId", "materialId"],
    model: MaterialStandardGroup,
    as: "standardGroupMaterials",
    required: false,
    separate: true,
    include: [{
        attributes: ["id", "name", "groupType"],
        model: StandardGroup,
        required: true,
        include: [{
            attributes: ["id"],
            model: CategoryGroup,
            required: false,
            include: [{
                attributes: ["id", "description"],
                model: CategoryDesc,
                required: false
            }]
        }],
        where: {
            status: RECORD_STATUS.ACTIVE,
        }
    }]
});

@Injectable()
export class MaterialRepository {
    constructor(
        @InjectModel(Material) private readonly materialModel: typeof Material,
        @InjectModel(Comment) private readonly commentModel: typeof Comment,
        @InjectModel(UnitFavoriteMaterial) private readonly unitFavoriteMaterialModel: typeof UnitFavoriteMaterial,
        @InjectModel(StandardGroup) private readonly standardGroupModel: typeof StandardGroup
    ) { }

    async fetchExcelMaterials() {
        const materials = await this.materialModel.findAll({
            include: [{
                attributes: ["materialId"],
                model: MaterialCategory,
                include: [{
                    attributes: ['description'],
                    model: MainCategory
                }]
            },
            {
                attributes: ["nickname"],
                model: MaterialNickname,
                required: false
            },
            getMaterialStandardGroupInclude()],
            where: {
                recordStatus: RECORD_STATUS.ACTIVE,
                [Op.and]: [
                    getMaterialSupplyCenterTypeWhere(),
                    getActiveToolStandardGroupConstraint()
                ]
            }
        });

        const standardGroups = await this.standardGroupModel.findAll({
            include: [{
                association: "nickname",
                required: false
            }, {
                association: "categoryGroup",
                required: false,
                include: [{
                    association: "categoryDesc",
                    attributes: ["id", "description"],
                    required: false
                }]
            }],
            where: {
                groupType: {
                    [Op.in]: [MATERIAL_TYPES.ITEM, MATERIAL_TYPES.TOOL]
                },
                status: RECORD_STATUS.ACTIVE,
            }
        });

        return { materials, standardGroups };
    }

    async fetchMaterialsForExcelImport(materialIds: string[]) {
        if (materialIds.length === 0) return Promise.resolve([]);

        const [materials, standardGroups] = await Promise.all([
            this.materialModel.findAll({
                attributes: ["id", "description", "multiply", "recordStatus", "unitOfMeasurement", "type", "centerId"],
                include: [{
                    attributes: ["nickname"],
                    model: MaterialNickname,
                    required: false
                }, {
                    attributes: ["materialId"],
                    model: MaterialCategory,
                    required: false,
                    include: [{
                        attributes: ["description"],
                        model: MainCategory,
                        required: false
                    }]
                },
                getMaterialStandardGroupInclude()],
                where: {
                    id: { [Op.in]: materialIds },
                    [Op.and]: [
                        getMaterialSupplyCenterTypeWhere(),
                        getActiveToolStandardGroupConstraint()
                    ]
                }
            }),
            this.standardGroupModel.findAll({
                include: [{
                    association: "nickname",
                    required: false
                }, {
                    association: "categoryGroup",
                    required: false,
                    include: [{
                        association: "categoryDesc",
                        attributes: ["id", "description"],
                        required: false
                    }]
                }],
                where: {
                    id: { [Op.in]: materialIds },
                    groupType: {
                        [Op.in]: [MATERIAL_TYPES.ITEM, MATERIAL_TYPES.TOOL]
                    },
                    status: RECORD_STATUS.ACTIVE
                }
            })
        ]);

        const standardGroupMaterials = standardGroups.map((group) => ({
            id: group.id,
            description: group.name,
            multiply: 0,
            recordStatus: RECORD_STATUS.ACTIVE,
            unitOfMeasurement: "יח",
            type: group.groupType,
            nickname: group.nickname,
            categoryGroup: group.categoryGroup,
            isStandardGroup: true,
        }));

        return [...materials, ...standardGroupMaterials];
    }

    async fetchBySearch(filter: string, unitId: number) {
        const searchFilter = filter ?? '';

        const materials = await this.materialModel.findAll({
            include: [{
                attributes: ["materialId"],
                model: MaterialCategory,
                include: [{
                    attributes: ['description'],
                    model: MainCategory
                }]
            },
            {
                attributes: ["nickname"],
                model: MaterialNickname,
                required: false
            },
            {
                attributes: ["materialId"],
                model: UnitFavoriteMaterial,
                where: { unitId },
                required: false
            },
            getMaterialStandardGroupInclude()],
            where: {
                [Op.and]: [
                    {
                        [Op.or]: [
                            { id: { [Op.iLike]: `%${searchFilter}%` } },
                            { description: { [Op.iLike]: `%${searchFilter}%` } },
                            { '$nickname.nickname$': { [Op.iLike]: `%${searchFilter}%` } }
                        ],
                    },
                    getMaterialSupplyCenterTypeWhere(),
                    getActiveToolStandardGroupConstraint()
                ],
                recordStatus: RECORD_STATUS.ACTIVE,
            },
        });

        const standardGroups = await this.standardGroupModel.findAll({
            include: [{
                association: "nickname",
                required: false
            }, {
                association: "categoryGroup",
                required: false,
                include: [{
                    association: "categoryDesc",
                    attributes: ["id", "description"],
                    required: false
                }]
            }],
            where: {
                [Op.or]: [
                    { id: { [Op.iLike]: `%${searchFilter}%` } },
                    { name: { [Op.iLike]: `%${searchFilter}%` } },
                    { '$nickname.nickname$': { [Op.iLike]: `%${searchFilter}%` } }
                ],
                groupType: {
                    [Op.in]: [MATERIAL_TYPES.ITEM, MATERIAL_TYPES.TOOL]
                },
                status: RECORD_STATUS.ACTIVE
            }
        });

        const materialIds = materials.map(material => material.id);
        const groupsIds = standardGroups.map(group => group.id);
        const searchResultIds = [...materialIds, ...groupsIds];

        const comments = searchResultIds.length === 0
            ? []
            : await this.commentModel.findAll({
                where: {
                    materialId: { [Op.in]: searchResultIds },
                    [Op.or]: [
                        { unitId },
                        { recipientUnitId: unitId }
                    ]
                },
                order: [["date", "DESC"]]
            });

        const favoriteIds = await this.fetchFavoriteIds(unitId);

        return {
            materials,
            comments,
            standardGroups,
            favoriteIds
        };
    }

    async fetchByIds(materialsIds: string[], unitId: number) {
        const materials = await this.materialModel.findAll({
            include: [{
                attributes: ["materialId"],
                model: MaterialCategory,
                include: [{
                    attributes: ['description'],
                    model: MainCategory
                }]
            },
            {
                attributes: ["nickname"],
                model: MaterialNickname,
                required: false
            },
            {
                attributes: ["materialId"],
                model: UnitFavoriteMaterial,
                where: { unitId },
                required: false
            },
            getMaterialStandardGroupInclude()],
            where: {
                id: { [Op.in]: materialsIds },
                recordStatus: RECORD_STATUS.ACTIVE,
                [Op.and]: [
                    getMaterialSupplyCenterTypeWhere(),
                    getActiveToolStandardGroupConstraint()
                ]
            },
        });
        const standardGroups = await this.standardGroupModel.findAll({
            include: [{
                association: "nickname",
                required: false
            }, {
                association: "categoryGroup",
                required: false,
                include: [{
                    association: "categoryDesc",
                    attributes: ["id", "description"],
                    required: false
                }]
            }],
            where: {
                id: { [Op.in]: materialsIds },
                groupType: {
                    [Op.in]: [MATERIAL_TYPES.ITEM, MATERIAL_TYPES.TOOL]
                },
                status: RECORD_STATUS.ACTIVE
            }
        })
        const favoriteIds = await this.fetchFavoriteIds(unitId);

        return {
            materials,
            standardGroups,
            favoriteIds
        };
    }

    private async fetchFavoriteIds(unitId: number) {
        const favorites = await this.unitFavoriteMaterialModel.findAll({
            attributes: ["materialId"],
            where: { unitId }
        });
        return new Set(favorites.map((favorite) => favorite.materialId));
    }
}
