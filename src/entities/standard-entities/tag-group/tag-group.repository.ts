import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { ITagGroup, TagGroup } from "./tag-group.model";
import { StandardTag } from "../standard-tag/standard-tag.model";
import { UnitStandardTags } from "../unit-standard-tag/unit-standard-tag.model";
import { UnitId } from "../../unit-entities/unit-id/unit-id.model";
import { Unit } from "../../unit-entities/unit/unit.model";
import { Op, Transaction } from "sequelize";

@Injectable()
export class TagGroupRepository {
    constructor(@InjectModel(TagGroup) private readonly tagGroup: typeof TagGroup) { }

    fetchAll(level: number) {
        return this.tagGroup.findAll({
            include: [{
                model: StandardTag,
                required: false,
                include: [{
                    model: UnitStandardTags,
                    required: false,
                    include: [{
                        model: UnitId,
                        required: false,
                        include: [{
                            model: Unit
                        }]
                    }],
                }],
                where: {
                    unitLevel: { [Op.gte]: level }
                }
            }]
        });
    }

    fetchById(id: number) {
        return this.tagGroup.findOne({
            where: { id }
        })
    }

    fetchByDescription(description: string) {
        return this.tagGroup.findOne({
            where: {
                description
            }
        })
    }

    createTagGroup(tagGroup: ITagGroup, transaction: Transaction) {
        return this.tagGroup.upsert(tagGroup, { transaction });
    }

    updateTagGroup(tagGroup: ITagGroup, transaction: Transaction) {
        return this.tagGroup.upsert(tagGroup, { transaction });
    }

    deleteTagGroup(id: number, transaction: Transaction) {
        return this.tagGroup.destroy({
            where: { id },
            transaction
        });
    }
}