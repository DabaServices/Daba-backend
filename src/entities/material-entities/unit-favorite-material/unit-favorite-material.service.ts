import { BadGatewayException, Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { MESSAGE_TYPES } from "../../../constants";
import { CreateUnitFavoriteMaterial, DeleteUnitFavoriteMaterial } from "./DTO/dto";
import { UnitFavoriteMaterialRepository } from "./unit-favorite-material.repository";

@Injectable()
export class UnitFavoriteMaterialService {
    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly repository: UnitFavoriteMaterialRepository
    ) { }

    async create(unitFavoriteMaterial: CreateUnitFavoriteMaterial) {
        try {
            return await this.sequelize.transaction((transaction) =>
                this.repository.create(unitFavoriteMaterial, transaction));
        } catch (error) {
            console.log(error);
            throw new BadGatewayException({
                message: 'שמירת חומר מועדף נכשלה, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            });
        }
    }

    async destroy(unitFavoriteMaterial: DeleteUnitFavoriteMaterial) {
        try {
            const deletedCount = await this.sequelize.transaction((transaction) =>
                this.repository.destroy(unitFavoriteMaterial, transaction));

            return {
                data: { deletedCount },
            };
        } catch (error) {
            console.log(error);
            throw new BadGatewayException({
                message: 'מחיקת חומר מועדף נכשלה, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            });
        }
    }
}
