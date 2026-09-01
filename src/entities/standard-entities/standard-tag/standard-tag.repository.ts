import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { IStandardTag, StandardTag } from "./standard-tag.model";
import { Op, Transaction } from "sequelize";
import { UnitStandardTags } from "../unit-standard-tag/unit-standard-tag.model";

@Injectable()
export class StandardTagRepository {
    constructor(@InjectModel(StandardTag) private readonly standardTag: typeof StandardTag) { }

    fetchByDescription(description: string, tagGroupId: number) {
        return this.standardTag.findOne({
            where: {
                tag: description,
                tagGroupId,
            }
        })
    }

    fetchById(id: number) {
        return this.standardTag.findOne({
            where: {
                id,
            }
        })
    }

    fetchIfUnitOnAnotherTagOnSameLevel(id: number, unitLevel: number, tagGroupId: number, unitId: number) {
        return this.standardTag.findOne({
            include: [{
                model: UnitStandardTags,
                where: {
                    unitId
                }
            }],
            where: {
                id: { [Op.ne]: id },
                unitLevel,
                tagGroupId
            }
        })
    }

    createTag(standardTag: IStandardTag, transaction: Transaction) {
        return this.standardTag.upsert(standardTag, { transaction });
    }

    updateTag(standardTag: IStandardTag, transaction: Transaction) {
        return this.standardTag.upsert(standardTag, { transaction });
    }

    deleteTag(id: number, transaction: Transaction) {
        return this.standardTag.destroy({ where: { id }, transaction });
    }
}