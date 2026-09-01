import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Transaction } from "sequelize";
import { IUnitStandardTags, UnitStandardTags } from "./unit-standard-tag.model";

@Injectable()
export class UnitStanadrdTagRepository {
    constructor(@InjectModel(UnitStandardTags) private readonly unitStandardTags: typeof UnitStandardTags) { }

    fetchUnitStandardTag(unitStandardTag: IUnitStandardTags) {
        return this.unitStandardTags.findOne({
            where: unitStandardTag
        })
    }

    createUnitStandardTag(unitStandardTag: IUnitStandardTags, transaction: Transaction) {
        return this.unitStandardTags.create(unitStandardTag, { transaction })
    }

    removeUnitStandardTag(unitStandardTag: IUnitStandardTags, transaction: Transaction) {
        return this.unitStandardTags.destroy({
            where: {
                unitId: unitStandardTag.unitId,
                tagId: unitStandardTag.tagId
            },
            transaction
        })
    }
}