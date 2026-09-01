import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Transaction } from "sequelize";
import { UnitFavoriteMaterial } from "./unit-favorite-material.model";
import { CreateUnitFavoriteMaterial, DeleteUnitFavoriteMaterial } from "./DTO/dto";

@Injectable()
export class UnitFavoriteMaterialRepository {
    constructor(@InjectModel(UnitFavoriteMaterial) private readonly unitFavoriteMaterialModel: typeof UnitFavoriteMaterial) { }

    create(unitFavoriteMaterial: CreateUnitFavoriteMaterial, transaction: Transaction) {
        return this.unitFavoriteMaterialModel.create(unitFavoriteMaterial, { transaction });
    }

    destroy(unitFavoriteMaterial: DeleteUnitFavoriteMaterial, transaction: Transaction) {
        return this.unitFavoriteMaterialModel.destroy({
            where: { ...unitFavoriteMaterial },
            transaction
        })
    }
}